import type { Db, ObjectId } from 'mongodb';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import type { PodField } from '../pod-templates/pod-templates.schemas.js';
import { type PodTemplateDoc, podTemplateKey, resolvePodTemplates } from '../pod-templates/pod-templates.service.js';
import { DEFAULT_POD_FIELDS } from './pod-validation.js';

export interface PodForm {
  templateId: ObjectId | null;
  version: number;
  fields: PodField[];
  extraSteps: string[];
}

type DoRef = Pick<DeliveryOrderDoc, '_id' | 'clientId' | 'jobGroupId'>;

const formOf = (tpl: PodTemplateDoc | null): PodForm =>
  tpl
    ? { templateId: tpl._id, version: tpl.version ?? 0, fields: tpl.fields, extraSteps: tpl.extraSteps }
    : { templateId: null, version: 0, fields: DEFAULT_POD_FIELDS, extraSteps: [] };

/** POD form per DO (keyed by DO id hex), with one template query for the whole list. */
export async function podFormsFor(db: Db, dos: DoRef[]): Promise<Map<string, PodForm>> {
  const templates = await resolvePodTemplates(db, dos.map((d) => ({ clientId: d.clientId, jobGroupId: d.jobGroupId })));
  return new Map(dos.map((d) => [d._id.toHexString(), formOf(templates.get(podTemplateKey(d.clientId, d.jobGroupId)) ?? null)]));
}

export async function podFormFor(db: Db, d: DoRef): Promise<PodForm> {
  return (await podFormsFor(db, [d])).get(d._id.toHexString())!;
}
