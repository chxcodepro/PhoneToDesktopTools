import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { Pressable } from 'react-native';

import { cn } from '@/lib/utils';

import { TextClassContext } from './text';

const buttonVariants = cva('flex-row items-center justify-center gap-2 rounded-md active:opacity-80', {
  variants: {
    variant: {
      default: 'bg-primary',
      destructive: 'bg-destructive',
      outline: 'border border-border bg-background active:bg-accent',
      secondary: 'bg-secondary',
      ghost: 'active:bg-accent',
    },
    size: {
      default: 'h-10 px-4',
      sm: 'h-8 px-3',
      lg: 'h-12 px-6',
      icon: 'h-10 w-10',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

const buttonTextVariants = cva('text-sm font-medium', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      destructive: 'text-destructive-foreground',
      outline: 'text-foreground',
      secondary: 'text-secondary-foreground',
      ghost: 'text-foreground',
    },
    size: { default: '', sm: 'text-xs', lg: 'text-base', icon: '' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export type ButtonProps = React.ComponentProps<typeof Pressable> &
  VariantProps<typeof buttonVariants> & { className?: string };

export function Button({ className, variant, size, disabled, ...props }: ButtonProps) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        role="button"
        disabled={disabled}
        className={cn(buttonVariants({ variant, size }), disabled && 'opacity-50', className)}
        {...props}
      />
    </TextClassContext.Provider>
  );
}
