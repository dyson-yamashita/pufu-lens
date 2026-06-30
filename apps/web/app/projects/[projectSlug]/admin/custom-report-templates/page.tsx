import { requireAdminProject } from '../../../../../src/admin-actions-shared';
import {
  createCustomReportTemplate,
  disableCustomReportTemplate,
  importCustomReportTemplate,
  updateCustomReportTemplate,
} from '../../../../../src/admin-custom-report-template-actions';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import {
  listCustomReportAssets,
  listCustomReportTemplates,
} from '../../../../../src/custom-report-repository';
import {
  CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
  CUSTOM_REPORT_TEMPLATE_EXPORT_SCHEMA_VERSION,
  CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION,
  type CustomReportLayoutV1,
} from '../../../../../src/custom-report-schema';
import { ActionForm, PendingSubmitButton } from '../../../../../src/form-buttons';
import { requireProjectAdminPage } from '../../../../../src/project-page-auth';
import { AppShell, PageHeader, StatusBadge } from '../../../../../src/ui';

const defaultLayout: CustomReportLayoutV1 = {
  schema_version: CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
  root: {
    id: 'root-row',
    type: 'row',
    children: [
      { id: 'report-title', type: 'title', level: 1, text: 'カスタムレポート' },
      { id: 'pufu-board', type: 'pufu_board', source: 'report_pufu_sources' },
      { id: 'copyright', type: 'copyright', text: '© Pufu Lens' },
    ],
  },
};

export default async function CustomReportTemplatesPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const project = await requireProjectAdminPage(projectSlug);
  const sql = getRequiredAdminSql();
  const adminProject = await requireAdminProject(sql, projectSlug);
  const [templates, assets] = await Promise.all([
    listCustomReportTemplates(sql, adminProject.id),
    listCustomReportAssets(sql, adminProject.id),
  ]);

  return (
    <AppShell active="custom-report-templates" canManageProject project={project}>
      <PageHeader
        title={`${project.name} Custom Report Templates`}
        subtitle="許可済みパーツの JSON layout と export/import artifact を管理します。"
      />
      <section className="panel" data-testid="custom-report-template-create-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Template</p>
            <h2>Create template</h2>
          </div>
        </div>
        <TemplateForm
          action={createCustomReportTemplate}
          buttonLabel="Create template"
          layout={defaultLayout}
          projectSlug={project.slug}
          testIdPrefix="custom-report-template-create"
        />
      </section>

      <section className="panel" data-testid="custom-report-template-import-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Import</p>
            <h2>Import template JSON</h2>
          </div>
          <span className="status-badge">assets: {assets.length}</span>
        </div>
        <p className="muted-copy">
          v1 では asset manifest が空の template JSON を import できます。画像 asset の再登録 UI
          は後続で扱います。
        </p>
        <ActionForm action={importCustomReportTemplate} className="project-create-form">
          <input name="projectSlug" type="hidden" value={project.slug} />
          <label className="project-create-description">
            <span>Export JSON</span>
            <textarea
              data-testid="custom-report-template-import-json-input"
              name="exportJson"
              required
              rows={12}
            />
          </label>
          <PendingSubmitButton
            className="primary-button"
            testId="custom-report-template-import-submit-button"
            title="Import custom report template"
          >
            Import template
          </PendingSubmitButton>
        </ActionForm>
      </section>

      <section className="panel" data-testid="custom-report-template-list-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Templates</p>
            <h2>Template list</h2>
          </div>
          <span className="mono">{templates.length} templates</span>
        </div>
        <div className="template-editor-list">
          {templates.map((template) => (
            <article
              className="template-editor-card"
              data-testid={`custom-report-template-${template.id}`}
              key={template.id}
            >
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">v{template.template_version}</p>
                  <h3>{template.name}</h3>
                </div>
                <StatusBadge status={template.is_active ? 'healthy' : 'held'} />
              </div>
              <TemplateForm
                action={updateCustomReportTemplate}
                buttonLabel="Save template"
                description={template.description ?? ''}
                layout={template.layout}
                name={template.name}
                projectSlug={project.slug}
                templateId={template.id}
                testIdPrefix={`custom-report-template-edit-${template.id}`}
              />
              <details className="export-json-panel">
                <summary
                  className="secondary-button"
                  data-testid={`custom-report-template-export-${template.id}-button`}
                >
                  Show export JSON
                </summary>
                <textarea
                  data-testid={`custom-report-template-export-${template.id}-output`}
                  readOnly
                  rows={12}
                  value={buildExportJson({
                    description: template.description,
                    layout: template.layout,
                    name: template.name,
                  })}
                />
              </details>
              {template.is_active ? (
                <ActionForm action={disableCustomReportTemplate} className="inline-form">
                  <input name="projectSlug" type="hidden" value={project.slug} />
                  <input name="templateId" type="hidden" value={template.id} />
                  <PendingSubmitButton
                    className="danger-button"
                    testId={`custom-report-template-disable-${template.id}-button`}
                    title="Disable custom report template"
                  >
                    Disable
                  </PendingSubmitButton>
                </ActionForm>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </AppShell>
  );
}

function TemplateForm({
  action,
  buttonLabel,
  description = '',
  layout,
  name = '',
  projectSlug,
  templateId,
  testIdPrefix,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly buttonLabel: string;
  readonly description?: string;
  readonly layout: CustomReportLayoutV1;
  readonly name?: string;
  readonly projectSlug: string;
  readonly templateId?: string;
  readonly testIdPrefix: string;
}) {
  return (
    <ActionForm action={action} className="project-create-form">
      <input name="projectSlug" type="hidden" value={projectSlug} />
      {templateId ? <input name="templateId" type="hidden" value={templateId} /> : null}
      <label>
        <span>Name</span>
        <input
          data-testid={`${testIdPrefix}-name-input`}
          defaultValue={name}
          name="name"
          required
          type="text"
        />
      </label>
      <label className="project-create-description">
        <span>Description</span>
        <textarea
          data-testid={`${testIdPrefix}-description-input`}
          defaultValue={description}
          name="description"
          rows={2}
        />
      </label>
      <label className="project-create-description">
        <span>Layout JSON</span>
        <textarea
          className="mono"
          data-testid={`${testIdPrefix}-layout-input`}
          defaultValue={JSON.stringify(layout, null, 2)}
          name="layoutJson"
          required
          rows={16}
        />
      </label>
      <PendingSubmitButton
        className="primary-button"
        testId={`${testIdPrefix}-submit-button`}
        title={buttonLabel}
      >
        {buttonLabel}
      </PendingSubmitButton>
    </ActionForm>
  );
}

function buildExportJson(input: {
  readonly description: string | null;
  readonly layout: CustomReportLayoutV1;
  readonly name: string;
}): string {
  return JSON.stringify(
    {
      assets: [],
      exported_at: new Date().toISOString(),
      schema_version: CUSTOM_REPORT_TEMPLATE_EXPORT_SCHEMA_VERSION,
      template: {
        description: input.description ?? undefined,
        layout: input.layout,
        name: input.name,
        schema_version: CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION,
      },
    },
    null,
    2,
  );
}
