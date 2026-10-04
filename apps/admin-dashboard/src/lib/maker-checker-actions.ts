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
import { mcApplyExtra, mcApplyTemplate, mcRejectExtra, mcRejectTemplate } from "@/lib/mdm-store";
import { applyTemplateVersion } from "@/lib/workflow-store";
import { applyCallbackClear, applyCallbackSet } from "@/lib/integration-store";

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
  // MDM (lib/mdm-store): a new template version, and a custom value on a field that needs approval.
  "mdm.template_update": { apply: (r, c) => mcApplyTemplate(r, c), reject: (r, c) => mcRejectTemplate(r, c) },
  "mdm.extra_update": { apply: (r, c) => mcApplyExtra(r, c), reject: (r, c) => mcRejectExtra(r, c) },
  // Workflow templates (lib/workflow-store): a proposed new version of a template.
  "workflow.template_update": { apply: (r, c) => applyTemplateVersion(r.payload, c) },
  // A banker's per-flow callback URL (lib/integration-store): set (written PENDING, then checked) or cleared.
  "callback.set": { apply: (r, c) => applyCallbackSet(r, c) },
  "callback.clear": { apply: (r, c) => applyCallbackClear(r, c) },
};
