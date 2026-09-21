import * as React from 'react';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/ui/primitives/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/ui/primitives/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/ui/primitives/popover';

export interface MultiSelectOption {
  value: string;
  label: string;
}

function MultiSelect({
  className,
  disabled,
  emptyText = 'No results found.',
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  selected,
}: {
  className?: string;
  disabled?: boolean;
  emptyText?: string;
  onChange: (selected: string[]) => void;
  options: MultiSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  selected: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const selectedSet = React.useMemo(() => new Set(selected), [selected]);

  function toggle(value: string) {
    onChange(
      selectedSet.has(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value],
    );
  }

  const label =
    selected.length === 0 ? placeholder : `${selected.length} selected`;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className={cn(
            'w-full justify-between font-normal',
            selected.length === 0 && 'text-muted-foreground',
            className,
          )}
          disabled={disabled}
          role="combobox"
          type="button"
          variant="outline"
        >
          {label}
          <ChevronsUpDownIcon
            aria-hidden="true"
            className="opacity-50"
            size={15}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selectedSet.has(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    onSelect={() => toggle(option.value)}
                    value={option.label}
                  >
                    <span
                      className={cn(
                        'flex size-4 items-center justify-center rounded-xs border border-border',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'opacity-50',
                      )}
                    >
                      {isSelected ? <CheckIcon size={12} /> : null}
                    </span>
                    {option.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export { MultiSelect };
