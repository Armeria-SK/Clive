import { configText } from './config.ts';
import { engineText } from './engine.ts';
import { guardText } from './guard.ts';
import { httpText } from './http.ts';
import { providerText } from './providers.ts';
import { storeText } from './stores.ts';
import { taskText } from './tasks.ts';
import { toolText } from './tools.ts';

export const CATALOGS = { task: taskText, provider: providerText, engine: engineText, guard: guardText, tool: toolText, store: storeText, http: httpText, config: configText } as const;
