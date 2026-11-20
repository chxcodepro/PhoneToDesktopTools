import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/utils';

import { TextClassContext } from './text';

const badgeVariants = cva('flex-row items-center gap-1 self-start rounded-full px-2 py-0.5', {
  variants: {
    variant: {
      default: 'bg-primary/10',
      success: 'bg-success/15',
      warning: 'bg-warning/15',
      destructive: 'bg-destructive/15',
      muted: 'bg-muted',
    },
  },
  defaultVariants: { variant: 'default' },
});

const badgeTextVariants = cva('text-xs font-medium', {
  variants: {
    variant: {
      default: 'text-primary',
      success: 'text-success-foreground',
      warning: 'text-warning-foreground',
      destructive: 'text-destructive',
      muted: 'text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
});

export type BadgeProps = React.ComponentProps<typeof View> &
  VariantProps<typeof badgeVariants> & { className?: string };

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <TextClassContext.Provider value={badgeTextVariants({ variant })}>
      <View className={cn(badgeVariants({ variant }), className)} {...props} />
    </TextClassContext.Provider>
  );
}
