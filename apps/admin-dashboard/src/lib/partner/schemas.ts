// The sub-merchant body of the staff and portal routes (/api/partners/*): amounts in rupees.
// The partner API has its own (lib/partner/api), in paise.

import { z } from "zod";
import { SUB_FLOWS } from "@/lib/partner/rules";

const amount = z.number().positive().nullable().optional();
export const subBodySchema = z.object({
  external_id: z.string(),
  legal_name: z.string(),
  display_name: z.string().nullable(),
  business_type: z.string().nullable(),
  category: z.string().nullable(),
  pan: z.string().nullable(),
  gstin: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  address: z.string().nullable(),
  flows: z.enum(SUB_FLOWS),
  min_amount: amount,
  max_amount: amount,
  daily_amount: amount,
}).partial().strict();
