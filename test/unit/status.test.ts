import { describe, expect, it } from 'vitest';
import { deriveDoStatus, deriveShipmentStatus, deriveStopStatus } from '../../src/lib/status.js';

describe('status derivation (spec §5.6)', () => {
  it('derives the stop status from the steps done there', () => {
    expect(deriveStopStatus(new Set())).toBe('PENDING');
    expect(deriveStopStatus(new Set(['ARRIVED']))).toBe('ARRIVED');
    expect(deriveStopStatus(new Set(['ARRIVED', 'UNLOAD_START']))).toBe('WORKING');
    expect(deriveStopStatus(new Set(['ARRIVED', 'DOCS_SUBMITTED']))).toBe('ARRIVED');
    expect(deriveStopStatus(new Set(['ARRIVED', 'DEPARTED']))).toBe('DONE');
  });

  it('derives the DO status from pickup and its latest POD', () => {
    expect(deriveDoStatus('PLANNED', { loaded: false, latestPod: null })).toBe('PLANNED');
    expect(deriveDoStatus('PLANNED', { loaded: true, latestPod: null })).toBe('PICKED_UP');
    expect(deriveDoStatus('PICKED_UP', { loaded: true, latestPod: { outcome: 'DELIVERED', status: 'submitted' } })).toBe('DELIVERED');
    expect(deriveDoStatus('DELIVERED', { loaded: true, latestPod: { outcome: 'DELIVERED', status: 'verified' } })).toBe('POD_VERIFIED');
    expect(deriveDoStatus('DELIVERED', { loaded: true, latestPod: { outcome: 'DELIVERED', status: 'rejected' } })).toBe('POD_REJECTED');
    expect(deriveDoStatus('PLANNED', { loaded: false, latestPod: { outcome: 'FAILED', status: 'submitted' } })).toBe('FAILED');
    expect(deriveDoStatus('FAILED', { loaded: false, latestPod: { outcome: 'FAILED', status: 'verified' } })).toBe('FAILED');
    expect(deriveDoStatus('UNASSIGNED', { loaded: true, latestPod: null })).toBe('UNASSIGNED');
  });

  it('derives only the system shipment transitions', () => {
    expect(deriveShipmentStatus('ACCEPTED', { driverEvents: 0, doStatuses: ['PLANNED'] })).toBe('ACCEPTED');
    expect(deriveShipmentStatus('ACCEPTED', { driverEvents: 1, doStatuses: ['PLANNED'] })).toBe('IN_TRANSIT');
    expect(deriveShipmentStatus('IN_TRANSIT', { driverEvents: 5, doStatuses: ['DELIVERED', 'PICKED_UP'] })).toBe('IN_TRANSIT');
    expect(deriveShipmentStatus('IN_TRANSIT', { driverEvents: 5, doStatuses: ['DELIVERED', 'FAILED'] })).toBe('COMPLETED');
    expect(deriveShipmentStatus('IN_TRANSIT', { driverEvents: 5, doStatuses: [] })).toBe('IN_TRANSIT');
    expect(deriveShipmentStatus('COMPLETED', { driverEvents: 9, doStatuses: ['POD_REJECTED'] })).toBe('COMPLETED');
    expect(deriveShipmentStatus('DISPATCHED', { driverEvents: 1, doStatuses: ['DELIVERED'] })).toBe('DISPATCHED');
  });
});
