from flask import Flask, jsonify, request
app = Flask(__name__)
TODOS = []

@app.route('/todos', methods=['GET'])
def list_todos():
    return jsonify(TODOS)

@app.route('/todos', methods=['POST'])
def add_todo():
    data = request.get_json(silent=True) or {}
    TODOS.append({"text": data.get("text", "")})
    return jsonify(TODOS[-1]), 201

if __name__ == '__main__':
    app.run(port=5555)
