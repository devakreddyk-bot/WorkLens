import { ActionButton } from '@/components/ActionForm';
import { EnrollmentTokenForm } from '@/components/EnrollmentTokenForm';
import { Note } from '@/components/Fields';
import { Empty, Register, RegisterHead, Section, Td, Th, Tr } from '@/components/Register';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { revokeDeviceAction } from '@/lib/actions';
import { fetchDevices, fetchEmployees } from '@/lib/api';
import { formatLocalTime, formatShortDate } from '@/lib/format';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'Devices' };

/** A `timestamptz` as `17 Aug 09:12` in the organisation's zone, or an em dash. */
function moment(iso: string | null, timezone: string): string {
  if (iso === null) return '—';
  return `${formatShortDate(iso.slice(0, 10))} ${formatLocalTime(iso, timezone)}`;
}

/**
 * Enrolled machines, and how a new one gets enrolled.
 *
 * # The notice column is not decoration
 *
 * `notice_acknowledged_at` is the moment the person using that machine was shown what the software
 * collects and acknowledged it. A machine reporting without one is a machine whose user may not know it
 * is there, which is the single most important thing on this page — so it is a column, not a detail
 * behind a click.
 *
 * # Revoked, not deleted
 *
 * Revoking stops the agent's requests being accepted. It does not remove what that machine already
 * sent, and the interface says so: an owner revoking a laptop is usually doing it because somebody left,
 * and they should not be surprised later to find the records still there — or to find them gone.
 */
export default async function DevicesSettingsPage(): Promise<React.ReactElement> {
  const context = await loadPage();
  const [{ devices }, roster] = await Promise.all([fetchDevices(), fetchEmployees('active')]);

  const timezone = context.me.organization.timezone;
  const live = devices.filter((device) => device.revoked_at === null);
  const unacknowledged = live.filter((device) => device.notice_acknowledged_at === null);

  return (
    <Shell {...shellProps(context)}>
      <header className="mb-8">
        <p className="label">Settings</p>
        <h1 className="mt-1 text-[1.9rem] leading-tight">Devices</h1>
        <div className="mt-4">
          <SettingsNav current="/settings/devices" />
        </div>
      </header>

      {unacknowledged.length > 0 && (
        <div className="mb-8">
          <Note tone="flag">
            {unacknowledged.length} {unacknowledged.length === 1 ? 'machine has' : 'machines have'} not
            recorded that the person using {unacknowledged.length === 1 ? 'it' : 'them'} acknowledged the
            monitoring notice. The agent shows that notice on first run, so this usually means it has not
            been started by the person it belongs to.
          </Note>
        </div>
      )}

      <Section
        label="Register"
        title={`${live.length} active, ${devices.length - live.length} revoked`}
      >
        {devices.length === 0 ? (
          <Empty>
            No machines are enrolled. Issue a token below and run the enrolment command on the machine.
          </Empty>
        ) : (
          <Register>
            <RegisterHead>
              <Th>Person</Th>
              <Th className="w-[12rem]">Machine</Th>
              <Th className="w-[11rem]">System</Th>
              <Th className="w-[7rem]">Agent</Th>
              <Th numeric className="w-[9rem]">
                Last check-in
              </Th>
              <Th numeric className="w-[9rem]">
                Notice
              </Th>
              <Th className="w-[16rem]">&nbsp;</Th>
            </RegisterHead>
            <tbody>
              {devices.map((device, index) => (
                <Tr key={device.id} index={index}>
                  <Td>{device.full_name}</Td>
                  <Td className="figure text-[0.875rem]">{device.hostname}</Td>
                  <Td className="text-[0.875rem] text-ink-soft">
                    {device.os} {device.os_version}
                  </Td>
                  <Td className="figure text-[0.875rem] text-ink-soft">{device.agent_version}</Td>
                  <Td numeric className="text-ink-soft">
                    {moment(device.last_seen_at, timezone)}
                  </Td>
                  <Td numeric>
                    {device.notice_acknowledged_at === null ? (
                      <span className="label text-flag">not acknowledged</span>
                    ) : (
                      <span className="text-ink-soft">{moment(device.notice_acknowledged_at, timezone)}</span>
                    )}
                  </Td>
                  <Td>
                    {device.revoked_at === null ? (
                      <ActionButton
                        action={revokeDeviceAction.bind(null, device.id)}
                        label="Revoke"
                        pendingLabel="Revoking"
                        tone="danger"
                        confirm={{
                          question: `Revoke ${device.hostname}?`,
                          detail:
                            'The agent on that machine stops being accepted immediately and cannot be re-enrolled with the same credentials. Everything it already sent is kept, and stays subject to the retention windows.',
                          confirmLabel: 'Revoke it',
                        }}
                      />
                    ) : (
                      <span className="label text-flag">Revoked {moment(device.revoked_at, timezone)}</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Register>
        )}
      </Section>

      <Section label="Enrol" title="A new machine">
        <div className="max-w-[48rem] border border-rule-strong bg-slip p-5">
          <p className="mb-5 text-[0.9rem] leading-relaxed text-ink-soft">
            An enrolment token is single-use and short-lived. The machine exchanges it for its own
            credentials on first run, and the token is spent.
          </p>
          <EnrollmentTokenForm
            employees={roster.employees.map((employee) => ({ id: employee.id, name: employee.full_name }))}
          />
        </div>
      </Section>
    </Shell>
  );
}
