// Master list for one type (components/mdm/master-list). An unknown type is a 404. Staff only.

import { notFound } from "next/navigation";
import { parseMasterType } from "@/lib/mdm";
import { MasterList } from "@/components/mdm/master-list";

export default async function MdmTypePage({ params }: { params: Promise<{ type: string }> }) {
  const type = parseMasterType((await params).type);
  if (!type) notFound();
  return <MasterList type={type} />;
}
