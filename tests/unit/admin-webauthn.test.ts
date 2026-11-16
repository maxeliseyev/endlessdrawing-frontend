import { describe, expect, it } from 'vitest';
import { creationOptions, fromBase64url, requestOptions, serializeAssertion, serializeAttestation, toBase64url } from '../../src/admin/webauthn';
import { ProtocolError } from '../../src/admin/contracts';

const buffer = (values: number[]) => new Uint8Array(values).buffer;
const request = { publicKey: { challenge: 'AQIDBA', rpId: 'endlessdrawing.com', userVerification: 'required',
  allowCredentials: [{ type: 'public-key', id: 'BQYH', transports: ['internal', 'hybrid'] }] }, mediation: 'optional' };
const creation = { publicKey: { challenge: 'AQIDBA', rp: { id: 'endlessdrawing.com', name: 'Endless Drawing' },
  user: { id: 'BQYH', name: 'moderator', displayName: 'Moderator' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' }, attestation: 'none',
  excludeCredentials: [{ type: 'public-key', id: 'CAkK' }] } };

it('round-trips all binary byte values and typed-array offsets without padding', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  expect(new Uint8Array(fromBase64url(toBase64url(bytes)))).toEqual(bytes);
  expect(toBase64url(bytes.subarray(1, 4))).toBe('AQID');
  expect(toBase64url(buffer([251, 255]))).toBe('-_8');
});
it.each(['', 'A', 'AQ==', 'a+b/', 'AQ ID', 'AR'])('rejects invalid/noncanonical base64url %s', (value) => {
  expect(() => fromBase64url(value)).toThrow();
});

it('converts request challenge/descriptors, preserves transports, mediation and extensions', () => {
  const options = requestOptions({ ...request, publicKey: { ...request.publicKey, extensions: {
    appid: 'https://endlessdrawing.com', prf: { eval: { first: 'AQID' } }, largeBlob: { write: 'BAUG' },
  } } });
  expect(options.publicKey?.challenge).toEqual(buffer([1, 2, 3, 4]));
  expect(options.publicKey?.allowCredentials?.[0]?.id).toEqual(buffer([5, 6, 7]));
  expect(options.publicKey?.allowCredentials?.[0]?.transports).toEqual(['internal', 'hybrid']);
  expect(options.mediation).toBe('optional');
  expect(options.publicKey?.extensions).toMatchObject({ prf: { eval: { first: buffer([1, 2, 3]) } }, largeBlob: { write: buffer([4, 5, 6]) } });
  expect(request.publicKey.challenge).toBe('AQIDBA');
});
it('converts creation challenge/user/exclusions without forcing a hardware attachment', () => {
  const options = creationOptions(creation).publicKey!;
  expect(options.user.id).toEqual(buffer([5, 6, 7]));
  expect(options.excludeCredentials?.[0]?.id).toEqual(buffer([8, 9, 10]));
  expect(options.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
  expect(options.attestation).toBe('none');
});
it('rejects downgraded user verification or unexpected attestation policy', () => {
  expect(() => requestOptions({ publicKey: { ...request.publicKey, userVerification: 'preferred' } })).toThrow(ProtocolError);
  expect(() => creationOptions({ publicKey: { ...creation.publicKey, attestation: 'direct' } })).toThrow(ProtocolError);
  expect(() => creationOptions({ publicKey: { ...creation.publicKey, authenticatorSelection: { userVerification: 'discouraged' } } })).toThrow(ProtocolError);
});

function credential(response: object): PublicKeyCredential {
  return { id: 'AQID', rawId: buffer([1, 2, 3]), type: 'public-key', response,
    getClientExtensionResults: () => ({ prf: { results: { first: buffer([8, 9]) } } }),
  } as unknown as PublicKeyCredential;
}
describe('explicit wire serialization (not JSON.stringify browserCredential)', () => {
  it('serializes assertion buffers, nullable userHandle and extensions with exact field names', () => {
    const response = { authenticatorData: buffer([4, 5]), clientDataJSON: buffer([6, 7]), signature: buffer([8, 9]), userHandle: null };
    expect(serializeAssertion(credential(response))).toEqual({ id: 'AQID', rawId: 'AQID', type: 'public-key',
      extensions: { prf: { results: { first: 'CAk' } } }, response: {
        authenticatorData: 'BAU', clientDataJSON: 'Bgc', signature: 'CAk', userHandle: null,
      } });
    expect(serializeAssertion(credential({ ...response, userHandle: buffer([1]) })).response.userHandle).toBe('AQ');
  });
  it('serializes attestationObject and transports for enrollment without a session grant', () => {
    const result = serializeAttestation(credential({ attestationObject: buffer([4, 5]), clientDataJSON: buffer([6, 7]), getTransports: () => ['internal'] }));
    expect(result.response).toEqual({ attestationObject: 'BAU', clientDataJSON: 'Bgc', transports: ['internal'] });
    expect(result).not.toHaveProperty('authenticated');
  });
  it('rejects malformed credentials instead of submitting empty buffers', () => {
    expect(() => serializeAssertion(credential({ authenticatorData: {} }))).toThrow(ProtocolError);
  });
});
