import { describe, expect, it } from 'vitest';
import { buildCreateDoBody, emptyCreateDoForm, isCreateDoFormReady, type CreateDoForm } from './CreateDoDialog';

const filled: CreateDoForm = {
  clientId: 'c1',
  serviceTypeId: 's1',
  materialId: 'm1',
  originLocationId: 'o1',
  destLocationId: 'd1',
  qty: '5',
  clientRef: 'PO-1',
};

describe('buildCreateDoBody', () => {
  it('coerces qty to a number and omits unit (server derives it from the material)', () => {
    const body = buildCreateDoBody(filled);
    expect(body).toEqual({
      clientId: 'c1',
      serviceTypeId: 's1',
      materialId: 'm1',
      originLocationId: 'o1',
      destLocationId: 'd1',
      qty: 5,
      clientRef: 'PO-1',
    });
    expect(body).not.toHaveProperty('unit');
  });

  it('sends null clientRef when left blank', () => {
    const body = buildCreateDoBody({ ...filled, clientRef: '' });
    expect(body.clientRef).toBeNull();
  });
});

describe('isCreateDoFormReady', () => {
  it('is not ready for the empty form', () => {
    expect(isCreateDoFormReady(emptyCreateDoForm)).toBe(false);
  });

  it('is ready once every pick is made and qty is positive', () => {
    expect(isCreateDoFormReady(filled)).toBe(true);
  });

  it('is not ready when qty is zero or non-numeric', () => {
    expect(isCreateDoFormReady({ ...filled, qty: '0' })).toBe(false);
    expect(isCreateDoFormReady({ ...filled, qty: 'abc' })).toBe(false);
  });
});
