import { ConsoleMailer, ResendMailer } from './mailer';

describe('ResendMailer', () => {
  const email = { to: 'p@example.test', subject: 'Hi', text: 'body' };
  let fetchSpy: jest.SpyInstance;

  afterEach(() => fetchSpy?.mockRestore());

  it('POSTs to the Resend API with the key and payload', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await new ResendMailer('re_test_key', 'River <no-reply@river.test>').send(email);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'River <no-reply@river.test>',
      to: email.to,
      subject: email.subject,
      text: email.text,
    });
  });

  it('throws when Resend responds with a non-2xx status', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 422 }));

    await expect(new ResendMailer('k', 'f').send(email)).rejects.toThrow(/422/);
  });
});

describe('ConsoleMailer', () => {
  it('never sends and never throws', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      new ConsoleMailer().send({ to: 'x@y.z', subject: 's', text: 't' }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
