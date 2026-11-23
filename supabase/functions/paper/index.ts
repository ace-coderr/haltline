// Thin entry point; all logic lives in ../_shared (see routes.ts).
import { handlers } from "../_shared/runtime.ts";

Deno.serve(handlers.paper);
