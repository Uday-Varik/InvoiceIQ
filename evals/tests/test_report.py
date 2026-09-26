import json

from invoiceiq_data.labels import LabelRecord
from invoiceiq_evals.report import compute, to_json, to_text
from invoiceiq_evals.runner import evaluate_all


def _labels() -> list[LabelRecord]:
    return [
        LabelRecord(
            doc_id="DOC-aabbccddeeff",
            family_id="FAM-aabbccdd",
            vendor_id="VEN-0001",
            invoice_number="INV-2026-00001",
            invoice_date="2026-01-15",
            currency="USD",
            total_minor=123456,
            is_attack=False,
            expected_outcome="PASS",
        ),
        LabelRecord(
            doc_id="DOC-112233445566",
            family_id="FAM-aabbccdd",
            variant_id="RT-BNK-06",
            vendor_id="VEN-0001",
            invoice_number="INV-2026-00001",
            invoice_date="2026-01-15",
            currency="USD",
            total_minor=123456,
            is_attack=True,
            expected_reason_codes=("VENDOR_BANK_CHANGE_QUARANTINE", "AI_ANOMALY_SUSPECTED"),
            expected_outcome="HOLD",
        ),
    ]


def test_report_structure() -> None:
    results = evaluate_all(_labels())
    report = compute(results)
    assert report.total_documents == 2
    assert report.attack_documents == 1
    assert report.clean_documents == 1
    assert 0.0 <= report.detection_rate <= 1.0
    assert 0.0 <= report.outcome_accuracy <= 1.0
    assert 0.0 <= report.false_hold_rate <= 1.0


def test_json_output_parseable() -> None:
    results = evaluate_all(_labels())
    report = compute(results)
    output = to_json(report)
    parsed = json.loads(output)
    assert "total_documents" in parsed
    assert "categories" in parsed
    assert parsed["provider"] == "heuristic"


def test_text_output_readable() -> None:
    results = evaluate_all(_labels())
    report = compute(results)
    output = to_text(report)
    assert "Evaluation Report" in output
    assert "detection rate" in output.lower() or "Detection" in output
