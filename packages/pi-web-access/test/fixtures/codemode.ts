// Pi's codemode extension in `only` mode, loaded as an extension because the SDK path adds no built-in extensions.
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

export default createCodemodeExtension({ mode: "only" });
