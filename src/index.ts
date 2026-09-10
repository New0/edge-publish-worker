/**
 * The Worker.
 *
 * Everything it does lives in `worker-entry.ts`, which is shared code and is
 * replaced wholesale when the runtime is updated. Site-specific choices go in
 * `site-config.ts` — that file is yours, this one is not.
 */

import { createWorker } from './worker-entry.js';
import { siteConfig } from './site-config.js';

export default createWorker(siteConfig);
