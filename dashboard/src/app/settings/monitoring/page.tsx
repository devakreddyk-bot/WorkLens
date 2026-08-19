import { MonitoringForm } from '@/components/MonitoringForm';
import { Note } from '@/components/Fields';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { fetchMonitoringConfig } from '@/lib/api';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'Monitoring' };

/**
 * The monitoring configuration.
 *
 * Everything on this page changes what is taken off somebody else's laptop, so the page is built around
 * two rules that `MonitoringForm` implements: each setting states its consequence beside the control,
 * and nothing saves without a diff showing exactly what is changing from what to what.
 *
 * The page itself only fetches. It does not check that the caller is an owner: `POLICY.ownerWrite`
 * refuses a manager on both `GET` and `PUT`, so a manager who reaches this URL is told by the server
 * rather than by a second opinion here that could drift from it.
 */
export default async function MonitoringSettingsPage(): Promise<React.ReactElement> {
  const context = await loadPage();
  const { config, config_version: configVersion } = await fetchMonitoringConfig();

  return (
    <Shell {...shellProps(context)}>
      <header className="mb-8">
        <p className="label">Settings</p>
        <h1 className="mt-1 text-[1.9rem] leading-tight">Monitoring</h1>
        <div className="mt-4">
          <SettingsNav current="/settings/monitoring" />
        </div>
        <div className="mt-5 max-w-[46rem] space-y-4">
          <p className="text-[0.9375rem] leading-relaxed text-ink-soft">
            These settings decide what every enrolled machine collects. Each one says what it does before
            you change it, and nothing is saved until you have seen a summary of the change.
          </p>
          <Note>
            Machines read this configuration when they next check in, within about fifteen minutes. Records
            already collected are not affected by a change here — except retention, which deletes on its
            next sweep.
          </Note>
        </div>
      </header>

      <MonitoringForm config={config} configVersion={configVersion} />
    </Shell>
  );
}
