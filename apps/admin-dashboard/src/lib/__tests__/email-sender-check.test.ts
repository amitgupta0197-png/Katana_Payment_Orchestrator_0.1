// Sender authentication for payment mails (lib/email-sender-check).

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSender, fromDomain, paymentEmailDomains, senderCheckMode, type MailHeader } from "@/lib/email-sender-check";

const AR_GOOD = `mx.google.com;
       dkim=pass header.i=@bharatpe.in header.s=s1 header.b=AbCd1234;
       spf=pass (google.com: domain of bounce@mail.bharatpe.in designates 198.51.100.4 as permitted sender) smtp.mailfrom=bounce@mail.bharatpe.in;
       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=bharatpe.in`;
const mail = (from: string, ar: string | null, extra: MailHeader[] = []): MailHeader[] => [
  ...(ar === null ? [] : [{ name: "Authentication-Results", value: ar }]),
  ...extra,
  { name: "From", value: from }, { name: "Subject", value: "Payment Received" },
];

test("a real provider mail, authenticated by Gmail, is trusted", () => {
  assert.deepEqual(checkSender(mail("BharatPe <noreply@bharatpe.in>", AR_GOOD)), { trusted: true, domain: "bharatpe.in", reason: null });
  // A subdomain of the provider, signed by the provider's own domain.
  assert.equal(checkSender(mail("alerts@mail.phonepe.com", "mx.google.com; dkim=pass header.i=@phonepe.com; dmarc=pass header.from=phonepe.com")).trusted, true);
});

test("a provider's name in the subject or the display name proves nothing", () => {
  const ar = "mx.google.com; dkim=pass header.i=@gmail.com; spf=pass smtp.mailfrom=someone@gmail.com; dmarc=pass header.from=gmail.com";
  const v = checkSender(mail('"BharatPe Payment Received" <someone@gmail.com>', ar));
  assert.deepEqual([v.trusted, v.domain], [false, "gmail.com"]);
  assert.match(v.reason!, /not a payment provider's domain/);
  // An address in the display name is a label; the real address is the one in angle brackets.
  assert.equal(checkSender(mail('"noreply@bharatpe.in" <attacker@evil.example>', AR_GOOD)).trusted, false);
});

test("a provider's address that the mail server did not authenticate is not trusted", () => {
  const spoof = "mx.google.com; spf=softfail smtp.mailfrom=x@evil.example; dkim=none; dmarc=fail (p=REJECT) header.from=bharatpe.in";
  assert.match(checkSender(mail("noreply@bharatpe.in", spoof)).reason!, /did not authenticate bharatpe.in/);
  // DKIM passing for someone else's domain says nothing about the From domain.
  const other = "mx.google.com; dkim=pass header.i=@evil.example; dmarc=none header.from=bharatpe.in";
  assert.equal(checkSender(mail("noreply@bharatpe.in", other)).trusted, false);
  assert.match(checkSender(mail("noreply@bharatpe.in", null)).reason!, /recorded no authentication result/);
});

test("a forged authentication header below the real one is ignored", () => {
  const real = "mx.google.com; dkim=none; spf=fail smtp.mailfrom=x@evil.example; dmarc=fail header.from=bharatpe.in";
  const forged = { name: "Authentication-Results", value: AR_GOOD };
  assert.equal(checkSender(mail("noreply@bharatpe.in", real, [forged])).trusted, false);
  // A header naming some other server is not the mailbox's own and is not believed.
  assert.match(checkSender(mail("noreply@bharatpe.in", AR_GOOD.replace("mx.google.com", "mail.evil.example"))).reason!, /not the mailbox's own server/);
});

test("a look-alike domain is not the provider's", () => {
  for (const from of ["pay@bharatpe.in.evil.example", "pay@notbharatpe.in", "pay@bharatpe-in.com"])
    assert.equal(checkSender(mail(from, AR_GOOD)).trusted, false, from);
});

test("a mail with two From headers, or none, is not trusted", () => {
  const two = [...mail("noreply@bharatpe.in", AR_GOOD), { name: "From", value: "attacker@evil.example" }];
  assert.match(checkSender(two).reason!, /more than one From/);
  assert.match(checkSender([{ name: "Authentication-Results", value: AR_GOOD }]).reason!, /no From/);
});

test("the From domain is read from the address, whatever surrounds it", () => {
  assert.equal(fromDomain("BharatPe <NoReply@BharatPe.in>"), "bharatpe.in");
  assert.equal(fromDomain("noreply@bharatpe.in"), "bharatpe.in");
  assert.equal(fromDomain("not an address"), null);
});

test("more provider domains come from the environment; the check is enforced unless set to report", () => {
  assert.ok(paymentEmailDomains({}).includes("bharatpe.in"));
  assert.ok(paymentEmailDomains({ PAYMENT_EMAIL_DOMAINS: "Example-Bank.co.in, not a domain" }).includes("example-bank.co.in"));
  assert.equal(paymentEmailDomains({ PAYMENT_EMAIL_DOMAINS: "not a domain" }).includes("not a domain"), false);
  assert.deepEqual([senderCheckMode({}), senderCheckMode({ EMAIL_SENDER_CHECK: "report" }), senderCheckMode({ EMAIL_SENDER_CHECK: "off" })], ["enforce", "report", "enforce"]);
});
