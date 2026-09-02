import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import type { ModelDescriptor } from '../types';

export type ModelOption = ModelDescriptor & { available: boolean };

export function selectableModelOptions(models: ModelDescriptor[], selectedModel: string): ModelOption[] {
  const options = models.map((model) => ({ ...model, available: true }));
  if (!selectedModel || options.some((model) => model.id.toLocaleLowerCase() === selectedModel.toLocaleLowerCase())) return options;
  return [{ id: selectedModel, displayName: selectedModel, available: false }, ...options];
}

export function ModelSwitcher({ models, value, busy, loading = false, changing = false, warning, onChange }: {
  models: ModelDescriptor[];
  value: string;
  busy: boolean;
  loading?: boolean;
  changing?: boolean;
  warning?: string;
  onChange(model: string): void;
}) {
  const options = selectableModelOptions(models, value);
  const selected = options.find((model) => model.id.toLocaleLowerCase() === value.toLocaleLowerCase());
  const label = selected?.displayName || value || '选择模型';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="model-switcher-trigger" type="button" aria-label={`切换模型，当前为 ${label}`}>
          <Cpu aria-hidden="true" />
          <span>{label}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="model-switcher-menu" side="top" sideOffset={8} align="start">
          <div className="model-switcher-heading">
            <strong>选择模型</strong>
            {busy ? <span>当前会话仍有运行或排队任务，暂时不能切换。</span> : warning ? <span>{warning}</span> : null}
          </div>
          <DropdownMenu.Separator />
          {loading ? <p className="model-switcher-empty">正在读取模型列表…</p> : null}
          {!loading && options.length === 0 ? <p className="model-switcher-empty">没有可用模型</p> : null}
          <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
            {options.map((model) => (
              <DropdownMenu.RadioItem className="model-switcher-item" key={model.id} value={model.id} disabled={busy || changing || !model.available}>
                <span>{model.displayName}{model.available ? '' : '（当前不可用）'}</span>
                <DropdownMenu.ItemIndicator className="model-switcher-check"><Check aria-hidden="true" /></DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
