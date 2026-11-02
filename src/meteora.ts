import { createRequire } from "node:module";
import type MeteoraDLMM from "@meteora-ag/dlmm";

const require = createRequire(import.meta.url);
const DLMM = require("@meteora-ag/dlmm") as typeof MeteoraDLMM;

export const createProgram = (DLMM as unknown as typeof import("@meteora-ag/dlmm")).createProgram;
export default DLMM;
