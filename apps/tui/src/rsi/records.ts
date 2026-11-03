import { join } from "node:path";
import { AdmissionLedger, Calibration, LayerVersions, Rejections } from "@chopin-ai/core";
import { rsiDirectory } from "../home.js";
import { Evidence } from "./harvest.js";
import { HeldProposals } from "./held.js";

/** The loop's records, by where they are kept. */
export function records() {
  const root = rsiDirectory();
  return {
    evidence: new Evidence(join(root, "evidence")),
    versions: new LayerVersions(join(root, "layer")),
    ledger: new AdmissionLedger(join(root, "ledger.jsonl")),
    rejections: new Rejections(join(root, "rejections.jsonl")),
    calibration: new Calibration(join(root, "calibration.jsonl")),
    certificates: join(root, "certificates"),
    spend: join(root, "spend.jsonl"),
    held: new HeldProposals(join(root, "held.jsonl")),
  };
}
