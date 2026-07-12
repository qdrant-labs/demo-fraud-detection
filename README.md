# Qdrant Fraud Detection

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/qdrant-fraud-detection-lockup-dark.png">
    <img src="public/qdrant-fraud-detection-lockup.png" alt="Fraud Detection by Qdrant" width="440">
  </picture>
</p>

**[Live demo](https://demo-fraud-detection-eta.vercel.app)**

![The wall: a geo-hop alert arcing from Madrid to Sydney, with the alert queue and the evidence panel](public/qdrant-fraud-detection-wall.png)

## What It Is

A real-time fraud detection demo for payment transactions. It stores 200 customer baselines, or 109,446 points, in one [Qdrant](https://qdrant.tech) collection and scores each new transaction against that customer's own history.

Each transaction becomes a 31-dimensional vector. Qdrant searches the nearest historical transactions for the same customer, computes an anomaly score, and stores the evidence behind the alert: nearest neighbors, distances, score, and timing.

The demo detects three synthetic fraud patterns:

- Geo-Hop: the card moves between distant cities too quickly.
- Card Testing Burst: many small attempts arrive in a short window.
- Amount Ladder: transaction amounts climb in a pattern unlike the customer baseline.

## Who It's For

This demo is relevant to:

- Fraud, risk, and payments teams evaluating per-customer anomaly detection.
- Data and machine learning teams that need explainable retrieval around model decisions.
- Platform teams that want one indexed collection for many customer baselines instead of one index, table, or namespace per customer.
- Engineers building streaming pipelines where new events must be searchable immediately.

## How It's Built

The scoring path is intentionally small:

1. Encode the transaction into a vector from amount, merchant, time, location, and recent customer behavior.
2. Store all customers in one Qdrant collection with an indexed customer ID.
3. For each new transaction, filter to that customer and retrieve similar historical transactions.
4. Compare the transaction's distance to its neighbors against the neighbors' own spread.
5. Alert when the ratio passes `2.0`.
6. Upsert the scored event with `wait: true`, so the next event can search against it.

The evidence panel is explainable because the alert stores the neighbor IDs, distances, and score math at scoring time. The anomaly score answers, "Is this unlike this customer's history?" The fraud label answers, "What changed?"

The labels are exact because this is a controlled demo: each launched attack is generated from a known scenario, such as Geo-Hop or Card Testing Burst. Qdrant provides the similar historical transactions and stored evidence that explain why the event looked abnormal.

In production, the label would usually come from a trained model, business rules, analyst feedback, or a mix of the three.

## Adapt It to Your Pipeline

To use the same pattern with real data:

- Replace the synthetic stream with your transaction feed.
- Train a model on your own transaction history and confirmed fraud cases.
- Store model vectors, customer IDs, timestamps, and decision metadata in Qdrant.
- Query with a customer filter so every score compares the event to that customer's own baseline.
- Store similar historical transactions with each alert so analysts can inspect why it fired.
- Calibrate thresholds, fraud labels, and learning windows with your own eval set.

The main files to adapt are:

- [`src/lib/features.ts`](src/lib/features.ts): vector encoding.
- [`src/lib/score.ts`](src/lib/score.ts): scoring flow.
- [`src/lib/qdrant.ts`](src/lib/qdrant.ts): collection schema and indexes.
- [`evals/`](evals): latency, cold start, tenant isolation, and detection checks.

## Run It

Requires:

- Qdrant Cloud cluster, 1-2 GB
- Node 20 or newer

```bash
npm install
cp .env.example .env          # fill in QDRANT_URL and QDRANT_API_KEY
npx tsx --env-file=.env scripts/seed.ts   # ~100k baseline points across 200 customers
npm run dev                   # http://localhost:3000
npm run evals                 # runs the suite against throwaway collections
```

## Scope

This is a retrieval demo, not a production fraud model. The data is synthetic, the fraud patterns are controlled, and the threshold is tuned for this generator. A real implementation should use your own transaction history, confirmed fraud labels, and evaluation process.

---

Licensed under Apache-2.0. See [LICENSE](LICENSE).
