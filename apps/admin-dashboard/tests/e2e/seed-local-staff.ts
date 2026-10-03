// `pnpm e2e:staff` — make sure the local staff login exists. Prints the email only; the
// password is in .env.local as E2E_STAFF_PASSWORD.
import { ensureLocalStaff } from "./local-staff";

ensureLocalStaff()
  .then((s) => { console.log(`local staff login ready: ${s.email} (password: E2E_STAFF_PASSWORD in .env.local)`); process.exit(0); })
  .catch((e) => { console.error((e as Error).message); process.exit(1); });
