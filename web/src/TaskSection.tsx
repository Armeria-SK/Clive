import { Icon } from './icons.tsx';

interface Props {
  open: boolean;
  label: string;
  count: number;
  hint: string;
  attention?: boolean;
  onToggle: () => void;
}

// タスクの一覧の折りたためる節の見出し（あなたの対応が必要 / 実行中・実行待ち / 予定 / 完了 / 気になること）。
export function SectionHead({ open, label, count, hint, attention = false, onToggle }: Props) {
  return (
    <button className="tk-sechead" aria-expanded={open} onClick={onToggle}>
      <span className="tk-chev"><Icon name="chevR" size={12} /></span>
      <span className={`tk-seclabel${attention ? ' attention' : ''}`}>{label}</span>
      <span className="tk-seccount">{count}</span>
      {hint && <span className="tk-sechint">{hint}</span>}
    </button>
  );
}
