import type { ModelView } from '../api.ts';
import { MemorySection, ToolsSection, WorkerSection } from './BehaviorSections.tsx';
import type { Profile } from '../api.ts';
import { AboutSection } from './AboutSection.tsx';
import { LookSection } from './LookSection.tsx';
import { KeysSection, ModelsSection, ProvidersSection } from './ModelsSection.tsx';
import type { SettingsSection } from './model.ts';
import { FileSection, ServerSection } from './SystemSections.tsx';
import type { SectionProps } from './types.ts';

export interface SectionViewProps extends SectionProps {
  section: SettingsSection;
  models: readonly ModelView[];
  probing: boolean;
  onProbe: () => void;
  selectedModel: string | null;
  onSelectModel: (id: string) => void;
  selectedProvider: string | null;
  onSelectProvider: (id: string) => void;
  apiKeys: Record<string, boolean>;
  configPath: string;
  hasConfigError: boolean;
  lastSavedAt: number | null;
  onNameSaved: (profile: Profile) => void;
  onRerunSetup: () => void;
}

export function SectionView(props: SectionViewProps) {
  const base = { draft: props.draft, saved: props.saved, update: props.update, problems: props.problems };
  switch (props.section) {
    case 'models':
      return <ModelsSection {...base} probes={props.models} probing={props.probing} onProbe={props.onProbe} selectedId={props.selectedModel} onSelect={props.onSelectModel} />;
    case 'providers':
      return <ProvidersSection {...base} selectedId={props.selectedProvider} onSelect={props.onSelectProvider} />;
    case 'keys': return <KeysSection draft={props.draft} apiKeys={props.apiKeys} />;
    case 'tools': return <ToolsSection {...base} />;
    case 'worker': return <WorkerSection {...base} />;
    case 'memory': return <MemorySection />;
    case 'about': return <AboutSection profileName={String((props.saved.profile as { name?: string } | undefined)?.name ?? '')} onNameSaved={props.onNameSaved} onRerunSetup={props.onRerunSetup} />;
    case 'look': return <LookSection {...base} />;
    case 'server': return <ServerSection {...base} />;
    case 'file': return <FileSection {...base} configPath={props.configPath} hasConfigError={props.hasConfigError} lastSavedAt={props.lastSavedAt} />;
  }
}
