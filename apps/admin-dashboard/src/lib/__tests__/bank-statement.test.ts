// Bank statement readers (lib/bank-statement): MT940 and camt.053.

import { test } from "node:test";
import assert from "node:assert/strict";
import { balances, detectFormat, parseCamt053, parseMt940, parseStatement, rrnIn } from "@/lib/bank-statement";

const MT940 = [
  "{1:F01HDFCINBBAXXX0000000000}{2:I940HDFCINBBXXXXN}{4:",
  ":20:STMT-20261002",
  ":25:50200012345678",
  ":28C:00275/001",
  ":60F:C261001INR100000,00",
  ":61:2610021002C500,00NTRFNONREF//HDFCN26275123456",
  ":86:UPI/CR/627512345678/ASHA KUMAR/okaxis/asha.k@okaxis/Order KP-1",
  ":61:2610021002C1250,50NTRF000000123456//S98765",
  "second line of the entry",
  ":86:IMPS/P2A/627500000001/RAVI",
  " TRADERS/HDFC",
  ":61:261002D300,00NCHGNONREF",
  ":86:SMS CHARGES Q2",
  ":61:2610021002RD100,00NTRFNONREF",
  ":86:REVERSAL OF CHARGE",
  ":62F:C261002INR101550,50",
  "-}",
].join("\r\n");

test("the two formats are told apart, and anything else is refused", () => {
  assert.equal(detectFormat(MT940), "MT940");
  assert.equal(detectFormat("<Document><BkToCstmrStmt></BkToCstmrStmt></Document>"), "CAMT053");
  assert.equal(detectFormat("txnid,amount\n1,2"), null);
  assert.deepEqual(parseStatement("hello"), { error: "not an MT940 or camt.053 statement" });
});

test("an MT940 statement is read: account, balances and every entry", () => {
  const s = parseMt940(MT940);
  assert.deepEqual([s.account, s.currency, s.opening, s.closing, s.problems], ["50200012345678", "INR", 100000, 101550.5, []]);
  assert.equal(s.entries.length, 4);
  assert.deepEqual(s.entries.map((e) => [e.direction, e.amount, e.date, e.reversal]), [
    ["CREDIT", 500, "2026-10-02", false], ["CREDIT", 1250.5, "2026-10-02", false],
    ["DEBIT", 300, "2026-10-02", false], ["CREDIT", 100, "2026-10-02", true],   // a reversed debit is money back in
  ]);
  assert.equal(balances(s), true);
});

test("the UPI reference, payer and bank reference come from the entry's own words", () => {
  const [a, b] = parseMt940(MT940).entries;
  assert.deepEqual([a.rrn, a.payerName, a.payerVpa, a.bankRef, a.customerRef], ["627512345678", "ASHA KUMAR", "asha.k@okaxis", "HDFCN26275123456", null]);
  // A wrapped :86: and a supplementary line are joined; the customer reference is kept.
  assert.deepEqual([b.rrn, b.customerRef, b.bankRef], ["627500000001", "000000123456", "S98765"]);
  assert.match(b.narration, /second line of the entry IMPS\/P2A\/627500000001\/RAVI TRADERS\/HDFC/);
});

test("a reference is only taken when the entry holds exactly one 12-digit number", () => {
  assert.equal(rrnIn("UPI/CR/627512345678/X"), "627512345678");
  assert.equal(rrnIn("627512345678 and 627512345679"), null);
  assert.equal(rrnIn("account 50200012345678"), null);            // 14 digits is not a 12-digit reference
  assert.equal(rrnIn("627512345678 627512345678"), "627512345678");
});

test("an entry that cannot be read is reported, not guessed, and the statement no longer balances", () => {
  const s = parseMt940(MT940.replace(":61:2610021002C500,00NTRFNONREF//HDFCN26275123456", ":61:GARBAGE"));
  assert.equal(s.entries.length, 3);
  assert.match(s.problems[0], /:61: entry not readable/);
  assert.equal(balances(s), false);
});

const CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.06">
 <BkToCstmrStmt>
  <GrpHdr><MsgId>MSG-1</MsgId></GrpHdr>
  <Stmt>
   <Acct><Id><Othr><Id>50200012345678</Id></Othr></Id><Ccy>INR</Ccy></Acct>
   <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="INR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
   <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="INR">1650.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
   <Ntry>
    <Amt Ccy="INR">750.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
    <BookgDt><DtTm>2026-10-02T09:15:30+05:30</DtTm></BookgDt><ValDt><Dt>2026-10-02</Dt></ValDt>
    <AcctSvcrRef>BANKREF1</AcctSvcrRef>
    <NtryDtls><TxDtls>
      <Refs><EndToEndId>627512345678</EndToEndId></Refs>
      <RltdPties><Dbtr><Nm>Asha &amp; Sons</Nm></Dbtr></RltdPties>
      <RmtInf><Ustrd>UPI payment from asha@okhdfcbank</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
   </Ntry>
   <Ntry>
    <Amt Ccy="INR">100.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
    <BookgDt><Dt>2026-10-02</Dt></BookgDt>
    <AddtlNtryInf>Charges</AddtlNtryInf>
   </Ntry>
   <Ntry>
    <Amt Ccy="INR">999.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>PDNG</Sts>
    <BookgDt><Dt>2026-10-02</Dt></BookgDt>
   </Ntry>
  </Stmt>
 </BkToCstmrStmt>
</Document>`;

test("a camt.053 statement is read: booked entries only, with the time when it is stated", () => {
  const s = parseCamt053(CAMT);
  assert.deepEqual([s.account, s.currency, s.opening, s.closing, s.problems], ["50200012345678", "INR", 1000, 1650, []]);
  assert.equal(s.entries.length, 2);                               // the pending entry is not money that has moved
  const [c, d] = s.entries;
  assert.deepEqual([c.direction, c.amount, c.date, c.time, c.rrn, c.bankRef, c.payerName, c.payerVpa],
    ["CREDIT", 750, "2026-10-02", "2026-10-02T09:15:30+05:30", "627512345678", "BANKREF1", "Asha & Sons", "asha@okhdfcbank"]);
  assert.deepEqual([d.direction, d.amount, d.time, d.narration], ["DEBIT", 100, null, "Charges"]);
  assert.equal(balances(s), true);
});

test("camt.053 with a namespace prefix on every tag reads the same", () => {
  const prefixed = CAMT.replace(/<(\/?)([A-Z][A-Za-z]*)/g, "<$1ns:$2");
  const s = parseCamt053(prefixed);
  assert.deepEqual([s.entries.length, s.entries[0].rrn, s.account], [2, "627512345678", "50200012345678"]);
});
