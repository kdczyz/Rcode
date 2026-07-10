import type { LucideIcon } from "lucide-react";
import { ArrowLeft } from "lucide-react";
import { useId, type ReactNode } from "react";

export type SettingsNavItem<T extends string> = {
  id: T;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
};

export type SettingsNavGroup<T extends string> = {
  title: string;
  items: readonly SettingsNavItem<T>[];
};

type SettingsLayoutProps<T extends string> = {
  groups: readonly SettingsNavGroup<T>[];
  activeSection: T;
  onSectionChange: (section: T) => void;
  title: string;
  subtitle?: string;
  onBack: () => void;
  accountInitials: string;
  accountName: string;
  accountMeta: string;
  children: ReactNode;
};

export function SettingsLayout<T extends string>({
  groups,
  activeSection,
  onSectionChange,
  title,
  subtitle,
  onBack,
  accountInitials,
  accountName,
  accountMeta,
  children
}: SettingsLayoutProps<T>) {
  const headingId = useId();
  const navId = useId();

  return (
    <section className="settingsPage" aria-labelledby={headingId}>
      <aside className="settingsSidebar">
        <nav aria-label="设置导航">
          {groups.map((group, groupIndex) => {
            const groupHeadingId = `${navId}-${groupIndex}`;
            return (
              <section className="settingsNavGroup" key={group.title} aria-labelledby={groupHeadingId}>
                <h2 id={groupHeadingId}>{group.title}</h2>
                <div className="settingsNavList">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = item.id === activeSection;
                    return (
                      <button
                        className={`settingsNavItem${isActive ? " active" : ""}`}
                        key={item.id}
                        type="button"
                        aria-current={isActive ? "page" : undefined}
                        onClick={() => onSectionChange(item.id)}
                      >
                        <Icon size={18} aria-hidden="true" />
                        <span>{item.label}</span>
                        {item.shortcut && <kbd>{item.shortcut}</kbd>}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </nav>

        <div className="settingsNavFooter">
          <div className="accountAvatar" aria-hidden="true">{accountInitials}</div>
          <span>
            <strong>{accountName}</strong>
            <small>{accountMeta}</small>
          </span>
        </div>
      </aside>

      <section className="settingsMainPane" aria-labelledby={headingId}>
        <header className="settingsMainHeader">
          <button className="newChatButton" type="button" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            返回会话
          </button>
          <div>
            <h2 id={headingId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </header>
        <div className="settingsContentStack">{children}</div>
      </section>
    </section>
  );
}

type SettingsSectionProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function SettingsSection({
  title,
  description,
  action,
  className,
  children
}: SettingsSectionProps) {
  const sectionClassName = ["settingsPaneSection", className].filter(Boolean).join(" ");

  return (
    <section className={sectionClassName}>
      <div className="settingsPaneHeader">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
        {action}
      </div>
      {children}
    </section>
  );
}
