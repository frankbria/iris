import { translate, Action } from '../src/translator';

describe('translate()', () => {
  test('parses click commands', () => {
    const actions = translate('click #submit');
    expect(actions).toEqual<Action[]>([{ type: 'click', selector: '#submit' }]);
  });

  test('parses fill commands', () => {
    const actions = translate('fill input[name=email] with test@example.com');
    expect(actions).toEqual<Action[]>([
      { type: 'fill', selector: 'input[name=email]', text: 'test@example.com' },
    ]);
  });

  test('parses navigate commands', () => {
    const actions = translate('navigate to http://localhost:3000');
    expect(actions).toEqual<Action[]>([
      { type: 'navigate', url: 'http://localhost:3000' },
    ]);
  });

  test('returns empty array for unrecognized instructions', () => {
    const actions = translate('unsupported instruction');
    expect(actions).toEqual<Action[]>([]);
  });
});
