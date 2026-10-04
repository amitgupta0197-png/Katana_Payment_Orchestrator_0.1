// What approving or rejecting a Maker-Checker request does, per action (lib/maker-checker).
// The `provider.*` actions are applied by the route itself, as they always were.
//
// `apply` runs after the request is claimed; if it throws, the claim is undone and the request
// stays PENDING with the reason returned to the checker. Each apply is a guarded update, so a
// request decided twice cannot apply twice.

import {
  applyMidDeactivate, applyMidIssue, applyTspPermissions, applyTspStage, rejectMidIssue,
} from "@/lib/chain-store";
import type { Maker } from "@/lib/maker-checker";

export interface McRequest {
  request_id: string;
  resource_type: string;
  resource_id: string;
  action: string;
  payload: Record<string, any>;
}

export interface McAction {
  apply: (r: McRequest, checker: Maker) => Promise<unknown>;
  /** What a rejection undoes, when the request held something waiting. */
  reject?: (r: McRequest, checker: Maker) => Promise<void>;
}

export const MC_ACTIONS: Record<string, McAction> = {
  "mid.issue": {
    apply: (r, c) => applyMidIssue(r.resource_id, c),
    reject: (r, c) => rejectMidIssue(r.resource_id, c),
  },
  "mid.deactivate": { apply: (r, c) => applyMidDeactivate(r.resource_id, c) },
  "tsp.go_live": { apply: (r, c) => applyTspStage(r.resource_id, "CONFIG", "LIVE", c) },
  "tsp.suspend": { apply: (r, c) => applyTspStage(r.resource_id, "LIVE", "SUSPENDED", c) },
  "tsp.reactivate": { apply: (r, c) => applyTspStage(r.resource_id, "SUSPENDED", "LIVE", c) },
  "tsp.update_permissions": { apply: (r) => applyTspPermissions(r.resource_id, r.payload?.changes ?? {}) },
};
