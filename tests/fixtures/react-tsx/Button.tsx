import { formatLabel, classNames } from './hooks.js';

export function Button({ label, primary }: { label: string; primary?: boolean }) {
  const text = formatLabel(label);
  const cls = classNames('btn', primary ? 'btn-primary' : '');
  return <button className={cls}>{text}</button>;
}
