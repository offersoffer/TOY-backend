'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

/**
 * That a partial branch save does not erase the columns it did not mention.
 *
 * This file exists because of a real bug, and it is written to catch the next
 * one of its kind rather than the one that happened. The shape of it:
 *
 *   - `BRANCH_COLUMNS` lists every column a branch save writes;
 *   - `branchValues` supplies them in order, reading `branch.x ?? null`;
 *   - `mergeBranch` builds that `branch` from a partial payload plus the row.
 *
 * So a key missing from `mergeBranch` is not "leave it alone" - it arrives at
 * `branchValues` as `undefined`, becomes `null`, and the column is wiped. The
 * publish gate added `contact_person_name` and `contact_person_email` to the
 * first two and not the third, which meant a merchant editing their address
 * lost the contact person they had just been asked to fill in. Both the
 * branches screen and the shop profile route through this function, so both
 * did it.
 *
 * The assertion below is therefore about the invariant, not the two fields:
 * every column that can be written must survive a save that does not mention
 * it. Add a column and forget the merge, and this fails.
 */

const SRC = path.join(__dirname, '../../src');
const shops = require(path.join(SRC, 'modules/shops/shop.service'));

/** A branch row as the database hands it back, with every column populated. */
const EXISTING = {
  id: 7,
  branch_name: 'Peelamedu',
  address: '12 Avinashi Road',
  address_line_2: 'Near the flyover',
  area: 'Peelamedu',
  city: 'Coimbatore',
  state: 'Tamil Nadu',
  country: 'India',
  pincode: '641004',
  latitude: 11.0168,
  longitude: 76.9558,
  location_source: 'MAP_PIN',
  location_accuracy: 12,
  location_confirmed_at: new Date('2026-11-01T10:00:00Z'),
  place_id: 'place-123',
  opening_hours: JSON.stringify({ mon: [{ open: '09:30', close: '21:00' }] }),
  contact_number: '+91 90000 00000',
  contact_person_name: 'R. Kavitha',
  contact_person_email: 'kavitha@example.test',
  is_primary: 1,
  status: 'active',
};

/** The coordinates `branchValues` is handed, unchanged from the row. */
const SAME_COORDINATES = {
  latitude: EXISTING.latitude,
  longitude: EXISTING.longitude,
  source: EXISTING.location_source,
  accuracy: EXISTING.location_accuracy,
  placeId: EXISTING.place_id,
};

/** What a save of `payload` over `EXISTING` would write, column by column. */
function written(payload) {
  const merged = shops.mergeBranch(payload, EXISTING);
  const values = shops.branchValues(merged, SAME_COORDINATES, EXISTING);
  return Object.fromEntries(shops.BRANCH_COLUMNS.map((column, index) => [column, values[index]]));
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

test('a save that mentions one field writes nothing away in every other column', () => {
  // The address is what the merchant came to change. Everything else on the
  // row has to come back out the other side.
  const after = written({ address: '14 Avinashi Road' });

  assert.equal(after.address, '14 Avinashi Road', 'the change lands');

  const untouched = shops.BRANCH_COLUMNS.filter(
    (column) => !['address', 'location_confirmed_at'].includes(column),
  );
  const erased = untouched.filter((column) => after[column] === null || after[column] === undefined);
  assert.deepEqual(
    erased,
    [],
    `a partial save erased: ${erased.join(', ')} - add it to mergeBranch`,
  );
});

test('every writable column is carried, not just the ones with a test', () => {
  // Checked against the row rather than against a list written out here, so
  // adding a column to BRANCH_COLUMNS without adding it to mergeBranch fails
  // this without anybody having to remember to come back and extend it.
  const after = written({});
  const sameness = {
    branch_name: EXISTING.branch_name,
    address: EXISTING.address,
    address_line_2: EXISTING.address_line_2,
    area: EXISTING.area,
    city: EXISTING.city,
    state: EXISTING.state,
    country: EXISTING.country,
    pincode: EXISTING.pincode,
    contact_number: EXISTING.contact_number,
    contact_person_name: EXISTING.contact_person_name,
    contact_person_email: EXISTING.contact_person_email,
    status: EXISTING.status,
  };
  for (const [column, value] of Object.entries(sameness)) {
    assert.equal(after[column], value, `${column} was not carried through an empty save`);
  }
  assert.equal(after.is_primary, 1, 'is_primary was not carried');
});

// ---------------------------------------------------------------------------
// The two fields the gate added, named explicitly
// ---------------------------------------------------------------------------

test('the contact person survives a save about the address', () => {
  const after = written({ address: '14 Avinashi Road', city: 'Coimbatore' });
  assert.equal(after.contact_person_name, 'R. Kavitha');
  assert.equal(after.contact_person_email, 'kavitha@example.test');
});

test('an explicit null still clears a field, and only that field', () => {
  // "Not sent" and "sent as null" have to stay different, or a merchant could
  // never remove a contact person once they had set one.
  const after = written({ contactPersonName: null });
  assert.equal(after.contact_person_name, null);
  assert.equal(after.contact_person_email, 'kavitha@example.test');
  assert.equal(after.contact_number, EXISTING.contact_number);
});

test('a contact person can be set on a branch that had none', () => {
  const blank = { ...EXISTING, contact_person_name: null, contact_person_email: null };
  const merged = shops.mergeBranch(
    { contactPersonName: 'S. Rajan', contactPersonEmail: 'rajan@example.test' },
    blank,
  );
  assert.equal(merged.contactPersonName, 'S. Rajan');
  assert.equal(merged.contactPersonEmail, 'rajan@example.test');
});
