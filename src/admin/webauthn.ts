import { object, ProtocolError, text } from './contracts';

export class PasskeyError extends Error {
  constructor(readonly code: 'passkey_unsupported' | 'passkey_cancelled' | 'passkey_failed') { super(code); }
}

export function fromBase64url(value: unknown): ArrayBuffer {
  const encoded = text(value, 1_048_576);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw new ProtocolError();
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  if (toBase64url(bytes) !== encoded) throw new ProtocolError();
  return bytes.buffer;
}
export function toBase64url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function descriptors(value: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new ProtocolError();
  return value.map((item) => {
    const v = object(item);
    if (v.type !== 'public-key') throw new ProtocolError();
    const result: PublicKeyCredentialDescriptor = { type: 'public-key', id: fromBase64url(v.id) };
    if (v.transports !== undefined) {
      if (!Array.isArray(v.transports) || !v.transports.every((t) => typeof t === 'string')) throw new ProtocolError();
      result.transports = v.transports as AuthenticatorTransport[];
    }
    return result;
  });
}

function extensions(value: unknown): AuthenticationExtensionsClientInputs | undefined {
  if (value === undefined) return undefined;
  const result = { ...object(value) };
  if (result.credBlob !== undefined) result.credBlob = fromBase64url(result.credBlob);
  if (result.largeBlob !== undefined) {
    const blob = { ...object(result.largeBlob) };
    if (blob.write !== undefined) blob.write = fromBase64url(blob.write);
    result.largeBlob = blob;
  }
  if (result.prf !== undefined) {
    const prf = { ...object(result.prf) };
    const pair = (value: unknown) => {
      const input = object(value);
      return { first: fromBase64url(input.first), ...(input.second === undefined ? {} : { second: fromBase64url(input.second) }) };
    };
    if (prf.eval !== undefined) prf.eval = pair(prf.eval);
    if (prf.evalByCredential !== undefined) prf.evalByCredential = Object.fromEntries(
      Object.entries(object(prf.evalByCredential)).map(([key, item]) => [key, pair(item)]),
    );
    result.prf = prf;
  }
  return result as AuthenticationExtensionsClientInputs;
}

export function requestOptions(value: unknown): CredentialRequestOptions {
  const wrapper = object(value);
  const pk = object(wrapper.publicKey);
  if (pk.userVerification !== 'required') throw new ProtocolError();
  const publicKey = { ...pk, challenge: fromBase64url(pk.challenge),
    allowCredentials: descriptors(pk.allowCredentials), extensions: extensions(pk.extensions),
  } as PublicKeyCredentialRequestOptions;
  const result: CredentialRequestOptions = { publicKey };
  if (wrapper.mediation !== undefined) {
    if (!['conditional', 'optional', 'required', 'silent'].includes(String(wrapper.mediation))) throw new ProtocolError();
    result.mediation = wrapper.mediation as CredentialMediationRequirement;
  }
  return result;
}

export function creationOptions(value: unknown): CredentialCreationOptions {
  const wrapper = object(value);
  const pk = object(wrapper.publicKey);
  const user = object(pk.user);
  const selection = object(pk.authenticatorSelection);
  if (selection.userVerification !== 'required' || pk.attestation !== 'none') throw new ProtocolError();
  return { publicKey: { ...pk, challenge: fromBase64url(pk.challenge),
    user: { ...user, id: fromBase64url(user.id) }, excludeCredentials: descriptors(pk.excludeCredentials),
    extensions: extensions(pk.extensions),
  } as PublicKeyCredentialCreationOptions };
}

function jsonBuffers(value: unknown): unknown {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return toBase64url(value);
  if (Array.isArray(value)) return value.map(jsonBuffers);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonBuffers(v)]));
  return value;
}
function baseCredential(credential: PublicKeyCredential) {
  if (credential.type !== 'public-key' || !(credential.rawId instanceof ArrayBuffer)) throw new ProtocolError();
  const id = toBase64url(credential.rawId);
  if (credential.id !== id) throw new ProtocolError();
  return { id, rawId: id, type: 'public-key', extensions: jsonBuffers(credential.getClientExtensionResults()) };
}
export function serializeAssertion(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  if (!(response.authenticatorData instanceof ArrayBuffer) || !(response.signature instanceof ArrayBuffer) ||
      !(response.clientDataJSON instanceof ArrayBuffer) || (response.userHandle !== null && !(response.userHandle instanceof ArrayBuffer))) throw new ProtocolError();
  return { ...baseCredential(credential), response: {
    authenticatorData: toBase64url(response.authenticatorData), clientDataJSON: toBase64url(response.clientDataJSON),
    signature: toBase64url(response.signature), userHandle: response.userHandle === null ? null : toBase64url(response.userHandle),
  } };
}
export function serializeAttestation(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  if (!(response.attestationObject instanceof ArrayBuffer) || !(response.clientDataJSON instanceof ArrayBuffer)) throw new ProtocolError();
  return { ...baseCredential(credential), response: {
    attestationObject: toBase64url(response.attestationObject), clientDataJSON: toBase64url(response.clientDataJSON),
    transports: response.getTransports?.() ?? [],
  } };
}

function supported(): void {
  if (!window.isSecureContext || typeof PublicKeyCredential === 'undefined' || !navigator.credentials) throw new PasskeyError('passkey_unsupported');
}
function failure(error: unknown): never {
  if (error instanceof ProtocolError || error instanceof PasskeyError) throw error;
  if (error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)) throw new PasskeyError('passkey_cancelled');
  throw new PasskeyError('passkey_failed');
}
export async function authenticate(value: unknown, signal: AbortSignal) {
  supported();
  try {
    const credential = await navigator.credentials.get({ ...requestOptions(value), signal });
    if (!credential) throw new PasskeyError('passkey_cancelled');
    return serializeAssertion(credential as PublicKeyCredential);
  } catch (error) { failure(error); }
}
export async function register(value: unknown, signal: AbortSignal) {
  supported();
  try {
    const credential = await navigator.credentials.create({ ...creationOptions(value), signal });
    if (!credential) throw new PasskeyError('passkey_cancelled');
    return serializeAttestation(credential as PublicKeyCredential);
  } catch (error) { failure(error); }
}
