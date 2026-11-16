// Client-side mirror of api/app/domain/validation.py — instant feedback only; the server decides.
import { z } from 'zod';

import { graphemeCount, normalizeMobile, parseRupeesToPaise } from './format';

export { NOTE_MAX, formatINR, graphemeCount, normalizeMobile, parseRupeesToPaise } from './format';

const LETTER = /\p{L}/u;

export const nameSchema = z.string().trim().refine((v) => graphemeCount(v) >= 2, 'too_short')
  .refine((v) => graphemeCount(v) <= 100, 'too_long').refine((v) => LETTER.test(v), 'must_contain_letters')
  .refine((v) => /^[\p{L}\p{M}\d .'\-,()&/\u200c\u200d]+$/u.test(v), 'invalid_characters');
export const mobileSchema = z.string().refine((v) => normalizeMobile(v) !== null, 'mobile_10_digits');
export const placeSchema = z.string().trim().min(1, 'required').max(80, 'too_long').regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}\s\-/#.,&+()']*$/u, 'unit_identifier_chars');
export const amountSchema = z.string().refine((v) => parseRupeesToPaise(v) !== null, 'amount_invalid');
export const dueDaySchema = z.coerce.number().int('integer_required').min(1, 'out_of_range').max(31, 'out_of_range');
export const addressSchema = z.string().trim().refine((v) => graphemeCount(v) >= 5, 'too_short').refine((v) => graphemeCount(v) <= 250, 'too_long');

