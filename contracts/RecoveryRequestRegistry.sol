// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice On-chain registry for case-specific recovery requests.
/// Approval/rejection only records consent; it does not transfer assets.
contract RecoveryRequestRegistry {
    enum Status { NONE, PENDING, APPROVED, REJECTED, EXPIRED }

    struct Request {
        address owner;
        uint256 caseId;
        uint256 chainId;
        uint256 amountWei;
        address destination;
        uint64 expiresAt;
        Status status;
    }

    uint256 public nextRequestId = 1;
    address public immutable operator;
    mapping(uint256 => Request) public requests;

    event RecoveryRequestCreated(
        uint256 indexed requestId,
        address indexed owner,
        uint256 indexed caseId,
        uint256 chainId,
        uint256 amountWei,
        address destination,
        uint64 expiresAt
    );

    event RecoveryRequestApproved(uint256 indexed requestId, address indexed owner);
    event RecoveryRequestRejected(uint256 indexed requestId, address indexed owner);
    event RecoveryRequestExpired(uint256 indexed requestId);

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    constructor(address _operator) {
        require(_operator != address(0), "invalid operator");
        operator = _operator;
    }

    function createRequest(
        address owner,
        uint256 caseId,
        uint256 chainId,
        uint256 amountWei,
        address destination,
        uint64 expiresAt
    ) external onlyOperator returns (uint256 requestId) {
        require(owner != address(0), "invalid owner");
        require(caseId > 0, "invalid case");
        require(destination != address(0), "invalid destination");
        require(expiresAt > block.timestamp, "expired");

        requestId = nextRequestId++;
        requests[requestId] = Request({
            owner: owner,
            caseId: caseId,
            chainId: chainId,
            amountWei: amountWei,
            destination: destination,
            expiresAt: expiresAt,
            status: Status.PENDING
        });

        emit RecoveryRequestCreated(
            requestId, owner, caseId, chainId, amountWei, destination, expiresAt
        );
    }

    function approve(uint256 requestId) external {
        Request storage r = requests[requestId];
        require(r.owner == msg.sender, "not owner");
        require(r.status == Status.PENDING, "not pending");
        require(block.timestamp <= r.expiresAt, "expired");
        r.status = Status.APPROVED;
        emit RecoveryRequestApproved(requestId, msg.sender);
    }

    function reject(uint256 requestId) external {
        Request storage r = requests[requestId];
        require(r.owner == msg.sender, "not owner");
        require(r.status == Status.PENDING, "not pending");
        require(block.timestamp <= r.expiresAt, "expired");
        r.status = Status.REJECTED;
        emit RecoveryRequestRejected(requestId, msg.sender);
    }

    function expire(uint256 requestId) external {
        Request storage r = requests[requestId];
        require(r.status == Status.PENDING, "not pending");
        require(block.timestamp > r.expiresAt, "not expired");
        r.status = Status.EXPIRED;
        emit RecoveryRequestExpired(requestId);
    }
}
