import type { Student } from '../students/schema';

const rep = (value: number, count: number) => Array.from({ length: count }, () => value);

/** Максимальный первичный балл за каждое задание варианта, по порядку номеров. */
export const EXAM_MAX_SCORES: Record<NonNullable<Student['exam']>, number[]> = {
  oge: [...rep(1, 19), ...rep(2, 6)],
  ege_base: rep(1, 21),
  ege_profile: [...rep(1, 12), 2, 3, 2, 2, 3, 4, 4],
};

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
