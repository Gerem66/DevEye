import './style.css';
import HomePageBack from './back';
import { Navbar } from '../../components/components';

/**
 * @typedef {import('../../context').ReactContextType} ReactContextType
 */

class HomePage extends HomePageBack {
    render() {
        const { context } = this.state;
        const { user } = /** @type {ReactContextType} */ (this.context);
        if (user === null) return null;

        return (
            <div id='home' className='home'>
                <div className="home-left">
                    <Navbar
                        context={context}
                        setContext={(context) => this.setState({ context })}
                        setContent={(content) => this.setState({ content })}
                    />
                </div>

                <div className="home-right">
                    {/* Content */}
                    {this.state.content}
                </div>
            </div>
        );
    }
}

export default HomePage;
