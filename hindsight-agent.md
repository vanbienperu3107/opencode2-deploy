# Hướng dẫn bộ nhớ Hindsight (bank opencode2) — BẢN ĐỀ XUẤT qua proxy

Ghi chú: bản này thay thế `sync_retain` bằng `retain` và chỉ áp dụng KHI MCP `hindsight` đã trỏ tới proxy (`http://172.31.250.34:18490/mcp/`). Không áp dụng bản này nếu MCP còn trỏ thẳng upstream, vì khi đó `retain` không có chống ghi đè.

Bạn có công cụ bộ nhớ Hindsight (MCP `hindsight`). Quy tắc:

1. Bank đã được cấu hình sẵn là `opencode2` ở cấp MCP. KHÔNG truyền tham số `bank_id` cho bất kỳ lệnh nào (recall, retain, list_memories). Không gọi `list_banks`, không đổi bank.
2. Khi câu hỏi cần memory (thông tin cá nhân, quyết định, bối cảnh dự án đã có từ phiên trước), gọi `hindsight.recall` đúng MỘT lần với câu hỏi rõ ràng trước khi trả lời. Không gọi `list_memories` lặp lại. Nếu kết quả rỗng, nói rõ là không có dữ liệu. Ghi mới có thể chưa tìm thấy ngay vì xử lý bất đồng bộ; nếu người dùng vừa yêu cầu ghi, nói rõ điều đó thay vì khẳng định không có.
3. Khi trả lời "hiện tại": ưu tiên thông tin có ngày hiệu lực; nếu không có ngày hiệu lực thì dùng ngày ghi nhận mới nhất và nói rõ đó là ngày ghi nhận. Nêu nguồn và ngày. Thông tin cũ bị thay thế phải nói rõ là cũ.
4. Mâu thuẫn: nếu các bản ghi cho giá trị khác nhau cho cùng một thuộc tính và không đủ ngày hoặc nguồn để xác định, nêu rõ là không chắc chắn, liệt kê từng giá trị kèm ngày. Không tự chọn chỉ vì nó đứng đầu.
5. Thời gian: khi người dùng cho ngày tuyệt đối kèm múi giờ hoặc có mốc tham chiếu rõ ràng, truyền `timestamp` ISO 8601 có múi giờ (ví dụ 2026-11-22T00:00:00+07:00). Nếu người dùng nói tương đối ("hôm qua", "tuần trước") mà thiếu mốc ngày tuyệt đối hoặc múi giờ, KHÔNG tự suy đoán ngày: hỏi lại người dùng trước khi ghi nhận. Không truyền `timestamp` khi không chắc.
6. Chỉ ghi nhận (`retain`) khi người dùng yêu cầu rõ (ví dụ "hãy ghi nhớ"). Trước khi ghi, recall một lần; nếu đã có nội dung tương đương CÙNG NGÀY/CÙNG SỰ KIỆN thì KHÔNG ghi lại.
7. Mỗi fact độc lập dùng MỘT `document_id` ổn định theo thuộc tính, dạng `<chu-de>-<thuoc-tinh>` viết thường không dấu, chỉ gồm a-z, 0-9 và dấu gạch ngang, dài 3–119 ký tự (ví dụ `alpha-model`). BẮT BUỘC truyền `document_id`; thiếu hoặc sai định dạng thì proxy từ chối. Khi cập nhật cùng thuộc tính, dùng lại đúng document_id đó. Không dùng chung một document_id cho nhiều fact.
8. Sự kiện lặp theo ngày (cuộc họp, lịch định kỳ, báo cáo hằng ngày) hoặc sự kiện có ngày cụ thể: `document_id` PHẢI gồm ngày, dạng `<chu-de>-<YYYYMMDD>` (ví dụ `standup-20261121`). Không dùng cùng một document_id cho hai ngày khác nhau; nội dung giống nhau ở hai ngày vẫn là hai sự kiện.
9. Không lưu API key, mật khẩu, token, chuỗi kết nối hoặc toàn bộ hội thoại.
10. Nếu Hindsight không khả dụng hoặc không có kết quả, nói rõ điều đó và trả lời dựa trên thông tin hiện có.
11. Kết quả `retain` của proxy:
    - `accepted` kèm `operation_id`: đã nhận, đang xử lý. Báo đã nhận ghi nhận; không nói đã có trong bộ nhớ ngay.
    - `noop`: nội dung đã có sẵn. Không thử lại.
    - Từ chối vì "thao tác ghi chưa hoàn tất": đợi rồi thử lại sau khi xử lý xong; không gửi lại liên tục.
    - Từ chối vì "đã có nội dung khác": KHÔNG ghi đè. Báo người dùng và hỏi có muốn thay thế không. Chỉ dùng `update_mode=replace` khi người dùng yêu cầu rõ thay thế.
    - Từ chối vì thiếu hoặc sai `document_id`: sửa theo quy tắc 7 rồi thử lại một lần.
    - Lỗi "outcome unknown": không tự retry. Báo người dùng rằng chưa xác định được ghi có thành công không.
