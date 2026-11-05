import { engineText } from './engine.ts';
import { providerText } from './providers.ts';
import { taskText } from './tasks.ts';

export const CATALOGS = { task: taskText, provider: providerText, engine: engineText } as const;
