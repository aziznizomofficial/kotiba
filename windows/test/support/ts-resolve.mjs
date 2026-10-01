// Lets a CHILD PROCESS started by a test run the TypeScript sources directly: Node strips the
// types itself (erasable syntax only), and this hook maps the `.js` specifiers the sources are
// written with onto the `.ts` files beside them. Registered with `--import`.
import { register } from 'node:module';

register(new URL('./ts-resolve-hooks.mjs', import.meta.url));
