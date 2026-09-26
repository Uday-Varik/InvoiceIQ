from ai_service.providers import EchoProvider, HeuristicProvider
from invoiceiq_data.labels import LabelRecord
from invoiceiq_evals.runner import evaluate_all, evaluate_one


def test_clean_document_no_ai_signals() -> None:
    label = LabelRecord(
        doc_id="DOC-aabbccddeeff",
        family_id="FAM-aabbccdd",
        vendor_id="VEN-0001",
        invoice_number="INV-2026-00001",
        invoice_date="2026-01-15",
        currency="USD",
        total_minor=123456,
        is_attack=False,
        expected_outcome="PASS",
    )
    result = evaluate_one(label)
    assert result.extraction.fields.vendorName.value is not None
    assert result.extraction.fields.totalMinor.value is not None
    assert result.fired_ai_codes == frozenset()
    assert result.expected_ai_codes == frozenset()


def test_expected_ai_codes_filtered() -> None:
    label = LabelRecord(
        doc_id="DOC-112233445566",
        family_id="FAM-11223344",
        variant_id="RT-BNK-06",
        vendor_id="VEN-0010",
        invoice_number="INV-2026-10001",
        invoice_date="2026-02-20",
        currency="EUR",
        total_minor=5000000,
        is_attack=True,
        expected_reason_codes=("VENDOR_BANK_CHANGE_QUARANTINE", "AI_ANOMALY_SUSPECTED"),
        expected_outcome="HOLD",
    )
    result = evaluate_one(label)
    assert "VENDOR_BANK_CHANGE_QUARANTINE" not in result.expected_ai_codes
    assert "AI_ANOMALY_SUSPECTED" in result.expected_ai_codes


def test_evaluate_one_accepts_explicit_provider() -> None:
    label = LabelRecord(
        doc_id="DOC-aabbccddeeff",
        family_id="FAM-aabbccdd",
        vendor_id="VEN-0001",
        invoice_number="INV-2026-00001",
        invoice_date="2026-01-15",
        currency="USD",
        total_minor=123456,
        is_attack=False,
        expected_outcome="PASS",
    )
    result = evaluate_one(label, provider=HeuristicProvider())
    assert result.extraction.provider == "heuristic"


def test_evaluate_all_with_echo_provider() -> None:
    label = LabelRecord(
        doc_id="DOC-aabbccddeeff",
        family_id="FAM-aabbccdd",
        vendor_id="VEN-0001",
        invoice_number="INV-2026-00001",
        invoice_date="2026-01-15",
        currency="USD",
        total_minor=123456,
        is_attack=False,
        expected_outcome="PASS",
    )
    results = evaluate_all([label], provider=EchoProvider())
    assert len(results) == 1
    assert results[0].extraction.provider == "echo"
