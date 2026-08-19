import { ActionButton, ActionForm } from '@/components/ActionForm';
import { Field, Note, inputClass, figureInputClass, selectClass } from '@/components/Fields';
import { Empty, Register, RegisterHead, Section, Td, Th, Tr } from '@/components/Register';
import { Shell } from '@/components/Shell';
import { addProject, addProjectRule, removeProjectRule, restoreProject, retireProject } from '@/lib/actions';
import type { ProjectMatchType, ProjectRuleRow } from '@/lib/api';
import { fetchProjectRules, fetchProjects } from '@/lib/api';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'Projects' };

/** What each kind of rule looks at, in the words somebody writing one needs. */
const MATCH_TYPES: readonly { value: ProjectMatchType; label: string; explanation: string }[] = [
  {
    value: 'app_exe',
    label: 'Application',
    explanation: 'The executable name, exactly. For example code.exe or Figma.',
  },
  {
    value: 'url_host',
    label: 'Site',
    explanation: 'The host of a page open in a browser. For example github.com. Only recorded when web addresses are being collected.',
  },
  {
    value: 'title_contains',
    label: 'Title contains',
    explanation: 'Text appearing anywhere in the window title. The simplest rule and usually the right one.',
  },
  {
    value: 'title_regex',
    label: 'Title matches',
    explanation: 'A regular expression against the window title. Rejected when it does not compile, so a broken pattern fails here rather than silently every night.',
  },
];

function matchLabel(type: ProjectMatchType): string {
  return MATCH_TYPES.find((entry) => entry.value === type)?.label ?? type;
}

/**
 * Projects and the rules that attribute time to them.
 *
 * # Retired, not deleted
 *
 * `timesheet_project_totals` cascades from `projects`, so deleting a project would rewrite history —
 * every past breakdown that named it would vanish and a payroll export run last month would stop
 * reproducing. The control says Retire and the API deactivates, and the page says which of the two it
 * did rather than reporting a deletion that did not happen.
 *
 * # There is no preview
 *
 * The plan asked for a live "what would this match" panel and the API has nothing to answer it with:
 * attribution runs in the overnight aggregation against recorded events, and there is no endpoint that
 * evaluates a candidate pattern. Rather than fake one against a sample, the page says when a new rule
 * will show up — tomorrow, in tomorrow's breakdowns — which is the fact somebody actually needs.
 */
export default async function ProjectsPage(): Promise<React.ReactElement> {
  const context = await loadPage();

  const { projects } = await fetchProjects();
  /* One request per project. The list is a management list — an organisation has tens of projects, not
     thousands — and the alternative is an endpoint that does not exist. Issued together rather than in
     sequence so the page waits once. */
  const ruleSets = await Promise.all(
    projects.map(async (project) => ({
      projectId: project.id,
      rules: (await fetchProjectRules(project.id)).rules,
    })),
  );
  const rulesByProject = new Map(ruleSets.map((entry) => [entry.projectId, entry.rules]));

  const active = projects.filter((project) => project.is_active);
  const retired = projects.filter((project) => !project.is_active);

  return (
    <Shell {...shellProps(context)}>
      <header className="mb-8">
        <p className="label">Projects</p>
        <h1 className="mt-1 border-b border-rule-strong pb-3 text-[1.9rem] leading-tight">
          Projects and their matching rules
        </h1>
        <p className="mt-3 max-w-[46rem] text-[0.9375rem] leading-relaxed text-ink-soft">
          A rule attributes recorded time to a project by looking at the application, the site or the
          window title. Attribution happens when timesheets are built overnight, so a rule added today
          appears in tomorrow&rsquo;s breakdowns and does not change yesterday&rsquo;s.
        </p>
      </header>

      <Section label="Register" title={`${active.length} active, ${retired.length} retired`}>
        {projects.length === 0 ? (
          <Empty>No projects yet. Add one below, then give it a rule so time can be attributed to it.</Empty>
        ) : (
          <Register>
            <RegisterHead>
              <Th>Project</Th>
              <Th className="w-[9rem]">Code</Th>
              <Th numeric className="w-[6rem]">
                Rules
              </Th>
              <Th className="w-[8rem]">Status</Th>
              <Th className="w-[16rem]">&nbsp;</Th>
            </RegisterHead>
            <tbody>
              {projects.map((project, index) => (
                <Tr key={project.id} index={index}>
                  <Td>{project.name}</Td>
                  <Td className="figure text-[0.875rem] text-ink-soft">{project.code ?? '—'}</Td>
                  <Td numeric>{rulesByProject.get(project.id)?.length ?? 0}</Td>
                  <Td>
                    {project.is_active ? (
                      <span className="label">Active</span>
                    ) : (
                      <span className="label text-ink-faint">Retired</span>
                    )}
                  </Td>
                  <Td>
                    {project.is_active ? (
                      <ActionButton
                        action={retireProject.bind(null, project.id)}
                        label="Retire"
                        pendingLabel="Retiring"
                        confirm={{
                          question: `Retire ${project.name}?`,
                          detail:
                            'It stops being offered for new attribution. Its rules stay, and every past breakdown that names it is untouched — nothing is deleted.',
                          confirmLabel: 'Retire it',
                        }}
                      />
                    ) : (
                      <ActionButton
                        action={restoreProject.bind(null, project.id)}
                        label="Make active"
                        pendingLabel="Restoring"
                      />
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Register>
        )}
      </Section>

      <Section label="Add" title="A new project">
        <div className="max-w-[38rem] border border-rule-strong bg-slip p-5">
          <ActionForm
            action={addProject}
            submitLabel="Add project"
            pendingLabel="Adding"
            resetOnSuccess
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Name" htmlFor="name">
                <input id="name" name="name" type="text" required maxLength={120} className={inputClass} />
              </Field>
              <Field
                label="Code"
                htmlFor="code"
                hint="Optional. Whatever your invoicing calls this project."
              >
                <input id="code" name="code" type="text" maxLength={40} className={inputClass} />
              </Field>
            </div>
          </ActionForm>
        </div>
      </Section>

      {projects.map((project) => (
        <Section
          key={project.id}
          label={project.is_active ? 'Rules' : 'Rules — retired project'}
          title={project.name}
          aside={
            <span className="label text-ink-faint">
              lowest number first, first match wins
            </span>
          }
        >
          <Rules projectId={project.id} rules={rulesByProject.get(project.id) ?? []} />
        </Section>
      ))}

      <Note>
        Rules are read in order of their number, lowest first, and the first one that matches an event
        wins. Give a broad rule a high number so a specific one can sit in front of it.
      </Note>
    </Shell>
  );
}

function Rules({
  projectId,
  rules,
}: {
  projectId: string;
  rules: readonly ProjectRuleRow[];
}): React.ReactElement {
  return (
    <div>
      {rules.length === 0 ? (
        <Empty>
          No rules, so nothing is attributed to this project. Add one below and it takes effect in
          tomorrow&rsquo;s timesheets.
        </Empty>
      ) : (
        <Register>
          <RegisterHead>
            <Th numeric className="w-[6rem]">
              Order
            </Th>
            <Th className="w-[11rem]">Looks at</Th>
            <Th>Pattern</Th>
            <Th className="w-[14rem]">&nbsp;</Th>
          </RegisterHead>
          <tbody>
            {rules.map((rule, index) => (
              <Tr key={rule.id} index={index}>
                <Td numeric>{rule.priority}</Td>
                <Td>{matchLabel(rule.match_type)}</Td>
                <Td className="figure text-[0.875rem]">{rule.pattern}</Td>
                <Td>
                  <ActionButton
                    action={removeProjectRule.bind(null, projectId, rule.id)}
                    label="Delete"
                    pendingLabel="Deleting"
                    confirm={{
                      question: 'Delete this rule?',
                      detail:
                        'Future activity stops matching it. Time already attributed by it stays attributed — past timesheets are not recalculated.',
                      confirmLabel: 'Delete it',
                    }}
                  />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Register>
      )}

      <div className="mt-5 max-w-[44rem] border border-rule bg-slip p-5">
        <ActionForm
          action={addProjectRule.bind(null, projectId)}
          submitLabel="Add rule"
          pendingLabel="Adding"
          resetOnSuccess
        >
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="Looks at" htmlFor={`match-${projectId}`}>
              <select id={`match-${projectId}`} name="match_type" className={selectClass} defaultValue="title_contains">
                {MATCH_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Pattern" htmlFor={`pattern-${projectId}`}>
              <input
                id={`pattern-${projectId}`}
                name="pattern"
                type="text"
                required
                maxLength={400}
                className={`${inputClass} font-mono text-[0.8125rem]`}
              />
            </Field>
            <Field label="Order" htmlFor={`priority-${projectId}`} hint="Lower runs first.">
              <input
                id={`priority-${projectId}`}
                name="priority"
                type="number"
                min={0}
                max={10000}
                defaultValue={100}
                className={figureInputClass}
              />
            </Field>
          </div>

          <dl className="mt-4 space-y-1.5 border-t border-rule pt-3 text-[0.8125rem]">
            {MATCH_TYPES.map((type) => (
              <div key={type.value} className="flex gap-3">
                <dt className="label w-28 shrink-0 pt-0.5">{type.label}</dt>
                <dd className="text-ink-soft">{type.explanation}</dd>
              </div>
            ))}
          </dl>
        </ActionForm>
      </div>
    </div>
  );
}
