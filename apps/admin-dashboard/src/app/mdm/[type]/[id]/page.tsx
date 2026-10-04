// One master record (components/mdm/record-view). An unknown type or a bad id is a 404. Staff only.

import { notFound } from "next/navigation";
import { parseMasterType } from "@/lib/mdm";
import { RecordView } from "@/components/mdm/record-view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MdmRecordPage({ params }: { params: Promise<{ type: string; id: string }> }) {
  const p = await params;
  const type = parseMasterType(p.type);
  if (!type || !UUID_RE.test(p.id)) notFound();
  return <RecordView type={type} id={p.id} />;
}
