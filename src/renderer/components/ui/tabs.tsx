import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { startTransition, useOptimistic } from "react"

type TabsProps = TabsPrimitive.Root.Props & {
  changeAction?: (value: TabsPrimitive.Tab.Value) => void | Promise<void>
}

function Tabs({ className, orientation = "horizontal", value, onValueChange, changeAction, ...props }: TabsProps) {
  const [optimisticValue, setOptimisticValue] = useOptimistic(value)
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
      value={optimisticValue}
      onValueChange={(next, details) => {
        onValueChange?.(next, details)
        if (!changeAction) return
        startTransition(async () => {
          setOptimisticValue(next)
          await changeAction(next)
        })
      }}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list relative isolate inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

const tabsIndicatorVariants = cva(
  "absolute top-0 left-0 transition-[translate,width,height] duration-200 ease-out motion-reduce:transition-none",
  {
    variants: {
      variant: {
        default:
          "-z-10 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) translate-y-(--active-tab-top) rounded-md bg-background shadow-sm dark:border dark:border-input dark:bg-input/30",
        line: [
          "bg-foreground",
          "group-data-horizontal/tabs:h-0.5 group-data-horizontal/tabs:w-[calc(var(--active-tab-width)-2px)] group-data-horizontal/tabs:translate-x-[calc(var(--active-tab-left)+1px)] group-data-horizontal/tabs:translate-y-[calc(var(--active-tab-top)+var(--active-tab-height)+2px)]",
          "group-data-vertical/tabs:h-[calc(var(--active-tab-height)-2px)] group-data-vertical/tabs:w-0.5 group-data-vertical/tabs:translate-x-[calc(var(--active-tab-left)+var(--active-tab-width)+1px)] group-data-vertical/tabs:translate-y-[calc(var(--active-tab-top)+1px)]",
        ],
      },
    },
  },
)

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator data-slot="tabs-indicator" className={tabsIndicatorVariants({ variant })} />
    </TabsPrimitive.List>
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "data-active:text-foreground dark:data-active:text-foreground",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel data-slot="tabs-content" className={cn("flex-1 text-sm outline-none", className)} {...props} />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
