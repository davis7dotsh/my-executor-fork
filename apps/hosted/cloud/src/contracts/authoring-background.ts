/** The current Worker entry owns background scheduling; cached HTTP routes receive only this callback. */
import { Context, Effect } from "effect";

export const AuthoringBackground = Context.Reference<
  (work: Effect.Effect<void>) => Effect.Effect<void>
>("executor/cloud/AuthoringBackground", { defaultValue: () => () => Effect.void });
