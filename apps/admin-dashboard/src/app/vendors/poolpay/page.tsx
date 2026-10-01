// The Katana Pay cockpit moved to /vendors/katana. Old bookmarks land there.
import { redirect } from "next/navigation";

export default function Page() {
  redirect("/vendors/katana");
}
