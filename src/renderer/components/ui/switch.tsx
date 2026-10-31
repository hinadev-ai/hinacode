import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "cn"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer group/switch @container relative inline-flex h-5 w-11 shrink-0 items-center rounded-full border border-transparent p-px transition-[background-color,border-color,box-shadow] duration-150 ease-out outline-none group-has-[:focus-visible]/field-label:border-transparent group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-input/80 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block h-4 w-6.5 rounded-full bg-background shadow-[0_1px_2px_rgb(0_0_0/0.15),0_0_0_0.5px_rgb(0_0_0/0.05)] transition-[translate,scale,background-color,box-shadow] duration-430 ease-spring group-active/switch:group-not-data-disabled/switch:scale-155 group-active/switch:group-not-data-disabled/switch:bg-white/50 group-active/switch:group-not-data-disabled/switch:shadow-[inset_0_1px_1px_rgb(255_255_255/0.8),inset_0_0_0_0.5px_rgb(255_255_255/0.5),0_2px_6px_rgb(0_0_0/0.15)] group-active/switch:group-not-data-disabled/switch:backdrop-blur-[2px] group-active/switch:group-not-data-disabled/switch:backdrop-brightness-85 motion-reduce:transition-colors dark:group-active/switch:group-not-data-disabled/switch:bg-white/15 data-checked:translate-x-[calc(100cqw-100%)] dark:data-checked:bg-primary-foreground dark:data-unchecked:bg-foreground"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
