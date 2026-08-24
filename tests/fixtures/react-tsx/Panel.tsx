import { Button } from './Button.js';
import { classNames } from './hooks.js';

export function Panel({ title }: { title: string }) {
  const cls = classNames('panel');
  return (
    <section className={cls}>
      <h2>{title}</h2>
      <Button label="save" primary />
    </section>
  );
}
