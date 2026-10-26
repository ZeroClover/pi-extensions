// Pi's codemode extension in `only` mode with no inline budget: no tool is listed, scripts find them by search.
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

export default createCodemodeExtension({ mode: "only", inlineBudget: 0 });
