# 记账小程序 Demo Brief

## Goal

A mobile-style expense tracker web app. Single user, mock data only.

## Pages

1. **首页 / Overview**: current month total spend, category breakdown list, recent 5 transactions.
2. **记一笔 / Add**: form with amount, category picker (餐饮/交通/购物/娱乐/其他), note, date. Adds to in-memory list.
3. **明细 / History**: full transaction list grouped by day, each row shows category icon, note, amount.

## Style

- Mobile viewport (390x844), card-based layout, soft rounded corners.
- Primary color: warm orange. Clean white background.
- Chinese UI text.

## Constraints

- Mock data: seed with ~15 transactions across the current month.
- No backend, no login, no persistence beyond page session.
- Amounts in CNY with ¥ prefix.

## Acceptance

- Overview page shows a total that equals the sum of seeded transactions.
- Add form appends a visible new row to History.
- All three pages reachable via a bottom tab bar.
