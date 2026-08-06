import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme, type ThemePref } from "../lib/useTheme";
import { Monitor, Moon, Sun } from "./Icons";

/** Sun/Moon/Monitor theme preference dropdown. */
export function ThemeToggle() {
  const [pref, setPref] = useTheme();
  const Icon = pref === "light" ? Sun : pref === "dark" ? Moon : Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Theme"
            title="Theme"
            className="text-haze-400"
          />
        }
      >
        <Icon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuRadioGroup
          value={pref}
          onValueChange={(value) => setPref(value as ThemePref)}
        >
          <DropdownMenuRadioItem value="light">
            <Sun className="size-3.5" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-3.5" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-3.5" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
