import { Type } from "typebox";

/** pi-ai's `StringEnum` infers `unknown` in `Type.Object` since Pi 1.5; this emits the same schema, correctly typed. */
export function stringEnum<const T extends readonly string[]>(values: T, options: { description?: string } = {}) {
	return Type.Unsafe<T[number]>({ type: "string", enum: values, ...options });
}
