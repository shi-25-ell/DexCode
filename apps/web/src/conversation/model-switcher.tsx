import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import { useState } from 'react';

const PREVIEW_MODELS = [
  'DeepSeek V4 Flash',
  'DeepSeek V4 Pro',
  'DeepSeek V4 Flash Vision',
] as const;

export function previewModelOptions(actualModel?: string): string[] {
  const names = actualModel ? [actualModel, ...PREVIEW_MODELS] : [...PREVIEW_MODELS];
  return names.filter((name, index) => names.findIndex((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase()) === index);
}

export function ModelSwitcher({ actualModel }: { actualModel?: string }) {
  const [previewModel, setPreviewModel] = useState<string>();
  const options = previewModelOptions(actualModel);
  const selectedModel = previewModel ?? actualModel ?? options[0]!;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="model-switcher-trigger" type="button" aria-label={`切换模型，当前为 ${selectedModel}`}>
          <Cpu aria-hidden="true" />
          <span>{selectedModel}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="model-switcher-menu" side="top" sideOffset={8} align="start">
          <div className="model-switcher-heading">
            <strong>选择模型</strong>
          </div>
          <DropdownMenu.Separator />
          <DropdownMenu.RadioGroup value={selectedModel} onValueChange={setPreviewModel}>
            {options.map((model) => (
              <DropdownMenu.RadioItem className="model-switcher-item" key={model} value={model}>
                <span>{model}</span>
                <DropdownMenu.ItemIndicator className="model-switcher-check"><Check aria-hidden="true" /></DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
