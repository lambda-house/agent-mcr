import { ArrowRightLeft } from 'lucide-react';
import HandoffWorkspace from '../../components/HandoffWorkspace';
import { createPlugin } from '../sdk';

export const plugin = createPlugin({
  id: 'handoff',
  name: 'Agent Handoff',
  version: '1.0.0',
  description: 'Multi-agent handoff timeline and task transfer view.',
  setup(api) {
    api.registerTopTab({
      id: 'handoff',
      label: 'Handoff',
      title: 'Inspect agent-to-agent handoffs and artifacts',
      order: 20,
      icon: <ArrowRightLeft size={13}/>,
      render: ({ active }) => <HandoffWorkspace active={active}/>,
    });
  },
});
